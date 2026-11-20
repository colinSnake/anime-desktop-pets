"""Private, one-shot quota source for the Electron video preview; no Qt or legacy host imports."""
from contextlib import closing
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import plistlib
import re
import selectors
import shutil
import sqlite3
import stat
import subprocess
import time
import tomllib
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE = 1024 * 1024
TIMI_BASE = re.compile(r'https://timicc\.com(?::443)?/?', re.IGNORECASE)
TIMI_ENV = re.compile(r'TIMI(?:_?CC)?_(?:API_KEY|TOKEN)')
CURRENCIES = frozenset(('USD', 'CNY', 'EUR', 'JPY', 'GBP', 'CAD', 'AUD'))
TEMPLATE = tuple(re.compile(pattern) for pattern in (
    r'''\burl\s*:\s*['"]\{\{baseUrl\}\}/v1/usage['"]''',
    r'''\bmethod\s*:\s*['"]GET['"]''',
    r'''['"]Authorization['"]\s*:\s*['"]Bearer \{\{apiKey\}\}['"]''',
))


class QuotaFailure(Exception):
    pass


def failure(code):
    return {'kind': 'error', 'code': code}


def record(value):
    return value if isinstance(value, dict) else {}


def is_timi(value):
    return isinstance(value, str) and TIMI_BASE.fullmatch(value) is not None


def read_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError('invalid config')
        raw = file.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError('oversized config')
    return tomllib.loads(raw.decode('utf-8'))


def timi_request(home, name, provider, env):
    db_path = home / '.cc-switch' / 'cc-switch.db'
    if not stat.S_ISREG(db_path.lstat().st_mode):
        raise ValueError('invalid database')
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=1)) as database:
        database.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 4 * MAX_RESPONSE)
        database.execute('PRAGMA query_only=ON')
        rows = database.execute("SELECT settings_config, meta FROM providers WHERE app_type='codex' AND is_current=1 LIMIT 2").fetchall()
    if len(rows) != 1:
        raise ValueError('ambiguous provider')
    settings, metadata = map(json.loads, rows[0])
    current = tomllib.loads(settings['config'])
    selected = current['model_providers'][current['model_provider']]
    script = record(metadata).get('usage_script', {})
    code = script.get('code')
    # Only recognize the declarative markers; never run JavaScript or use any URL or headers from it.
    if (current['model_provider'] != name or not is_timi(selected.get('base_url')) or
            script.get('enabled') is not True or script.get('language') not in (None, 'javascript') or
            not isinstance(code, str) or len(code) > 16384 or not all(pattern.search(code) for pattern in TEMPLATE)):
        raise ValueError('unmatched provider')
    env_key = provider.get('env_key')
    if selected.get('env_key') != env_key:
        raise ValueError('unmatched credential reference')
    if env_key not in (None, 'OPENAI_API_KEY'):
        if not isinstance(env_key, str) or not TIMI_ENV.fullmatch(env_key):
            raise ValueError('unmatched credential reference')
        key = env.get(env_key)
    else:
        # The generic OPENAI_API_KEY environment value may belong to a different service.
        key = record(settings.get('auth')).get('OPENAI_API_KEY')
    if not isinstance(key, str) or not re.fullmatch(r'[\x21-\x7e]{1,4096}', key):
        raise QuotaFailure('authentication')
    return Request('https://timicc.com/v1/usage', headers={'Authorization': f'Bearer {key}', 'Accept': 'application/json'}, method='GET')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def open_timi(request, timeout):
    return build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=timeout)


def read_quota(home, codex_home, env, official, http=open_timi):
    try:
        try:
            config = read_config(codex_home / 'config.toml')
        except FileNotFoundError:
            config = {}
        name = config.get('model_provider', 'openai')
        if not isinstance(name, str) or not name or len(name) > 128:
            return failure('configuration')
    except (OSError, ValueError):
        return failure('configuration')
    if name == 'openai':
        endpoint = env.get('OPENAI_BASE_URL') or config.get('openai_base_url')
        if endpoint not in (None, 'https://api.openai.com/v1', 'https://api.openai.com/v1/'):
            return failure('unsupported')
        try:
            return official()
        except QuotaFailure as error:
            return failure(error.args[0])
        except OSError:
            return failure('unavailable')

    provider = record(record(config.get('model_providers')).get(name))
    if not is_timi(provider.get('base_url')) or provider.get('requires_openai_auth') is True:
        return failure('unsupported')
    try:
        request = timi_request(home, name, provider, env)
    except QuotaFailure as error:
        return failure(error.args[0])
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        return failure('configuration')
    try:
        with http(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except HTTPError as error:
        error.close()
        if error.code in (401, 403):
            return failure('authentication')
        return failure('endpoint' if error.code == 404 or 300 <= error.code < 400 else 'network')
    except TimeoutError:
        return failure('timeout')
    except URLError as error:
        return failure('timeout' if isinstance(error.reason, TimeoutError) else 'network')
    except (OSError, HTTPException):
        return failure('network')
    if len(raw) > MAX_RESPONSE:
        return failure('response')
    try:
        value = record(json.loads(raw))
        if value.get('is_active', value.get('isValid')) is False:
            return failure('authentication')
        quota = record(value.get('quota'))
        remaining = next((x for x in (value.get('remaining'), quota.get('remaining'), value.get('balance')) if x is not None), None)
        unit = value.get('unit', quota.get('unit', 'USD'))
        if unit == 'RMB':
            unit = 'CNY'
        if type(remaining) not in (str, int, float) or not isinstance(unit, str) or unit not in CURRENCIES:
            return failure('response')
        amount = float(remaining)
        return {'kind': 'balance', 'amount': amount, 'currency': unit} if 0 <= amount <= 1e9 else failure('response')
    except (ValueError, OverflowError):
        return failure('response')


def find_codex(home, env):
    override = env.get('BAILONG_CODEX', '')
    path = os.pathsep.join(p for p in env.get('PATH', '').split(os.pathsep) if os.path.isabs(p))
    located = shutil.which('codex', path=path) if path else None
    for item in (override, located, '/opt/homebrew/bin/codex', '/usr/local/bin/codex', home / '.local/bin/codex'):
        if item and Path(item).is_absolute() and Path(item).is_file() and os.access(item, os.X_OK):
            return str(item)
    for directory in (Path('/Applications'), home / 'Applications'):
        for name in ('Codex.app', 'ChatGPT.app'):
            contents = directory / name / 'Contents'
            try:
                with (contents / 'Info.plist').open('rb') as file:
                    if plistlib.load(file).get('CFBundleIdentifier') != 'com.openai.codex':
                        continue
            except (OSError, ValueError, plistlib.InvalidFileException):
                continue
            for relative in ('codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex-cli/bin/codex', 'codex', 'bin/codex'):
                candidate = contents / 'Resources' / relative
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    return str(candidate)
    raise QuotaFailure('cli')


def subscription_windows(value):
    buckets = record(value.get('rateLimitsByLimitId'))
    limits = record(buckets.get('codex') or value.get('rateLimits'))
    rows = []
    for name in ('primary', 'secondary'):
        window = record(limits.get(name))
        used = window.get('usedPercent')
        minutes, resets = window.get('windowDurationMins'), window.get('resetsAt')
        remaining = max(0, 100 - used) if type(used) in (int, float) and 0 <= used <= 1e9 and math.isfinite(used) else None
        resets = resets if type(resets) is int and 1 <= resets <= 4102444800 else None
        if remaining is not None or resets is not None:
            rows.append({'minutes': minutes if type(minutes) is int and 1 <= minutes <= 525600 else None,
                         'remaining': remaining, 'resetsAt': resets})
    return {'kind': 'windows', 'rows': rows} if rows else failure('unavailable')


def read_official(executable, home, codex_home, env, timeout=12):
    # CLI owns its sign-in state. Do not inherit a relay API key or print its stdout/stderr verbatim.
    child_env = {name: env[name] for name in ('PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy') if name in env}
    child_env.update(HOME=str(home), CODEX_HOME=str(codex_home))
    deadline = time.monotonic() + timeout
    with subprocess.Popen([executable, 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env=child_env) as process, selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        pending = bytearray()
        total = 0

        def send(message):
            process.stdin.write(json.dumps(message).encode() + b'\n')
            process.stdin.flush()

        def result(identifier):
            nonlocal total
            while time.monotonic() < deadline:
                if b'\n' not in pending:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        break
                    chunk = os.read(process.stdout.fileno(), 8192)
                    total += len(chunk)
                    if not chunk or total > MAX_RESPONSE:
                        raise QuotaFailure('unavailable')
                    pending.extend(chunk)
                    continue
                end = pending.index(b'\n')
                line = pending[:end]
                del pending[:end + 1]
                try:
                    message = record(json.loads(line))
                except ValueError:
                    continue
                if type(message.get('id')) is not int or message['id'] != identifier:
                    continue
                if 'error' in message:
                    error = record(message['error'])
                    detail = str(error.get('message', '')).lower()
                    login = error.get('code') in (401, 403) or any(
                        word in detail for word in ('not logged', 'not authenticated', 'must be logged', 'requires authentication', 'unauthorized', 'sign in', 'token expired', '401'))
                    raise QuotaFailure('authentication' if login else 'unavailable')
                return record(message.get('result'))
            raise QuotaFailure('timeout')

        try:
            send({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'pet_video_preview', 'title': '桌边小崽', 'version': '1'}}})
            result(1)
            send({'method': 'initialized'})
            send({'id': 2, 'method': 'account/rateLimits/read'})
            return subscription_windows(result(2))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=.5)
                except subprocess.TimeoutExpired:
                    process.kill()


def main():
    try:
        home = Path.home()
        codex_home = Path(os.environ.get('CODEX_HOME') or home / '.codex').expanduser()
        if not codex_home.is_absolute():
            raise ValueError('relative Codex home')
        result = read_quota(home, codex_home, os.environ,
                            lambda: read_official(find_codex(home, os.environ), home, codex_home, os.environ))
        print(json.dumps(result, allow_nan=False))
    except Exception:
        print(json.dumps(failure('unavailable')))


if __name__ == '__main__':
    main()
