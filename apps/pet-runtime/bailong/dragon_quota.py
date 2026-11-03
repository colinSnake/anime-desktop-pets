"""显式额度查询：官方订阅走 app-server；TiMi 复用已配置的只读用量端点。"""
from contextlib import closing
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
import tomllib
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from quota import QuotaFailure, read_quota as official_read, quota_windows as official_windows

MAX_RESPONSE = 1024 * 1024


def _failure(message, code='provider_configuration'):
    return QuotaFailure(message, code, 'provider_usage')


def _base(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query
            or parsed.fragment or port not in (None, 443)):
        return None
    return value.rstrip('/')


def provider_request(home=None, cc_home=None):
    """Return None for official accounts. Never execute CC Switch's JavaScript."""
    home = Path(home or os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    try:
        config = tomllib.loads((home / 'config.toml').read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        raise _failure('无法读取 Codex 服务配置，请检查 config.toml。') from None
    name = config.get('model_provider', 'openai')
    if name == 'openai':
        return None
    provider = config.get('model_providers', {}).get(name, {})
    if provider.get('requires_openai_auth') is True:
        return None
    base = _base(provider.get('base_url'))
    if base is None or urlsplit(base).hostname != 'timicc.com' or urlsplit(base).path not in ('', '/'):
        raise _failure('当前使用第三方中转，官方订阅额度接口不适用；尚未接入该服务的余额接口。', 'provider_unsupported')
    # Only reuse an enabled, matching provider's specific declarative GET template.
    # Credentials are loaded only when the user explicitly requests quota.
    database = Path(cc_home or Path.home() / '.cc-switch') / 'cc-switch.db'
    try:
        with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as connection:
            row = connection.execute("SELECT settings_config, meta FROM providers WHERE app_type='codex' AND is_current=1 LIMIT 1").fetchone()
        if row is None:
            raise ValueError('no provider')
        if any(not isinstance(value, str) or len(value) > 2 * MAX_RESPONSE for value in row):
            raise ValueError('oversized settings')
        settings, metadata = (json.loads(value) for value in row)
        selected = tomllib.loads(settings['config'])
        selected_provider = selected['model_providers'][selected['model_provider']]
        script = metadata['usage_script']
        code = script['code']
        if (_base(selected_provider.get('base_url')) != base or script.get('enabled') is not True
                or script.get('language') not in (None, 'javascript') or len(code) > 16384):
            raise ValueError('unmatched provider')
        # Recognize one known adapter contract, without evaluating user code or URLs.
        patterns = (r'''\burl\s*:\s*['"]\{\{baseUrl\}\}/v1/usage['"]''',
                    r'''\bmethod\s*:\s*['"]GET['"]''',
                    r'''['"]Authorization['"]\s*:\s*['"]Bearer \{\{apiKey\}\}['"]''')
        if not all(re.search(pattern, code) for pattern in patterns):
            raise ValueError('unsupported template')
        key = os.environ.get(provider.get('env_key', '')) or settings.get('auth', {}).get('OPENAI_API_KEY')
        if not isinstance(key, str) or not key.strip() or '\n' in key or '\r' in key:
            raise ValueError('no key')
        return Request(base + '/v1/usage', headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'}, method='GET')
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        raise _failure('TiMi CC 使用中转余额；请在 CC Switch 为当前 Codex 服务启用匹配的 /v1/usage 用量查询配置。') from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Do not forward the provider credential to a redirect target.
        return None


def read_quota(timeout=20, cancel=None, **kwargs):
    from quota import log_attempt
    started = time.monotonic()
    try:
        return _read_quota(timeout, cancel, **kwargs)
    except QuotaFailure as error:
        if error.phase == 'provider_usage':
            log_attempt(1, time.monotonic() - started, error, kwargs.get('log_path'))
        raise


def _read_quota(timeout=20, cancel=None, **kwargs):
    request = provider_request()
    if request is None:
        return official_read(timeout=timeout, cancel=cancel, **kwargs)
    if cancel and cancel.is_set():
        raise _failure('额度查询已取消。', 'cancelled')
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise _failure('中转用量响应过大，未显示。', 'provider_response')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('invalid response')
        # The enabled CC Switch TiMi template uses these fields in this order.
        quota = value.get('quota') if isinstance(value.get('quota'), dict) else {}
        remaining = next((x for x in (value.get('remaining'), quota.get('remaining'), value.get('balance')) if x is not None), None)
        if isinstance(remaining, bool) or not isinstance(remaining, (str, int, float)):
            raise ValueError('missing balance')
        remaining = float(remaining)
        if not math.isfinite(remaining):
            raise ValueError('invalid balance')
        if value.get('is_active', value.get('isValid', True)) is False:
            raise _failure('TiMi CC 返回密钥未启用，请在服务商处检查。', 'provider_authentication')
        unit = value.get('unit', quota.get('unit', 'USD'))
        if not isinstance(unit, str) or len(unit) > 16 or any(ord(ch) < 32 for ch in unit):
            raise ValueError('invalid unit')
        if cancel and cancel.is_set():
            raise _failure('额度查询已取消。', 'cancelled')
        return {'providerBalance': {'name': 'TiMi CC', 'remaining': remaining, 'unit': unit}}
    except HTTPError as error:
        if error.code in (401, 403):
            raise _failure('TiMi CC 用量接口拒绝认证，请检查当前服务的密钥或查询权限。', 'provider_authentication') from None
        if error.code == 404:
            raise _failure('TiMi CC 当前端点未提供 /v1/usage，请在 CC Switch 核对查询配置。', 'provider_unsupported') from None
        raise _failure('TiMi CC 用量接口暂不可用（HTTP %d）。' % error.code, 'provider_http') from None
    except (URLError, TimeoutError, OSError):
        raise _failure('连接 TiMi CC 用量接口失败，请检查网络后再试。', 'provider_network') from None
    except (ValueError, TypeError, UnicodeError):
        raise _failure('TiMi CC 返回了无法识别的余额数据，请核对服务商的用量接口。', 'provider_response') from None


def quota_windows(data):
    if 'providerBalance' in data:
        return [dict(data['providerBalance'], kind='balance', resetsAt=None)]
    return official_windows(data)
