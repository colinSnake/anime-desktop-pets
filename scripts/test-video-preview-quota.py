#!/usr/bin/env python3
"""离线测试独立视频预览的额度来源；配置、进程和 HTTP 均为合成。"""
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/desktop/src/video-preview'))
import quota_source as source

CONFIG = 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://timicc.com/"\n'
TEMPLATE = '({url: "{{baseUrl}}/v1/usage", method: "GET", headers: {"Authorization": "Bearer {{apiKey}}"}})'


class QuotaSourceTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.codex_home = self.home / '.codex'
        self.codex_home.mkdir()
        self.config = self.codex_home / 'config.toml'
        self.config.write_text(CONFIG)
        self.cc = self.home / '.cc-switch'
        self.cc.mkdir()
        self.db = self.cc / 'cc-switch.db'
        self.settings = {'config': CONFIG, 'auth': {'OPENAI_API_KEY': 'synthetic-timi-key'}}
        self.meta = {'usage_script': {'enabled': True, 'language': 'javascript', 'code': TEMPLATE}}
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('CREATE TABLE providers(app_type TEXT,is_current INTEGER,settings_config TEXT,meta TEXT)')
        self.update()
        self.official = Mock(return_value={'kind': 'windows', 'rows': []})
        self.http = Mock(side_effect=lambda *_args, **_kw: io.BytesIO(b'{"quota":{"remaining":"12.50","unit":"USD"},"private":"fixture"}'))

    def update(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('DELETE FROM providers')
            db.execute('INSERT INTO providers VALUES (?,?,?,?)', ('codex', 1, json.dumps(self.settings), json.dumps(self.meta)))

    def read(self, env=None):
        return source.read_quota(self.home, self.codex_home, env or {}, self.official, self.http)

    def test_active_timi_reads_fixed_get_and_emits_only_the_amount(self):
        before = self.db.read_bytes()
        self.assertEqual(self.read(), {'kind': 'balance', 'amount': 12.5, 'currency': 'USD'})
        request = self.http.call_args.args[0]
        self.assertEqual((request.full_url, request.get_method()), ('https://timicc.com/v1/usage', 'GET'))
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-timi-key')
        self.assertEqual(self.db.read_bytes(), before)
        self.official.assert_not_called()
        self.assertIsNone(source.NoRedirect().redirect_request(request, None, 302, '', {}, 'https://elsewhere.invalid/'))

    def test_official_does_not_need_cc_switch(self):
        self.config.write_text('model_provider="openai"')
        self.db.unlink()
        self.assertEqual(self.read(), self.official.return_value)
        self.official.assert_called_once()
        self.http.assert_not_called()

    def test_unknown_or_mismatched_provider_never_falls_back_or_sends_key(self):
        for base in ('https://timicc.com.evil.invalid', 'http://timicc.com', 'https://timicc.com/v1', 'https://user@timicc.com'):
            self.config.write_text(CONFIG.replace('https://timicc.com/', base))
            self.assertEqual(self.read(), {'kind': 'error', 'code': 'unsupported'})
        self.config.write_text(CONFIG)
        for template in (TEMPLATE.replace('GET', 'POST'), TEMPLATE.replace('/v1/usage', '/elsewhere')):
            self.meta['usage_script']['code'] = template
            self.update()
            self.assertEqual(self.read(), {'kind': 'error', 'code': 'configuration'})
        self.meta['usage_script']['code'] = TEMPLATE
        self.settings['config'] = CONFIG.replace('custom', 'other')
        self.update()
        self.assertEqual(self.read(), {'kind': 'error', 'code': 'configuration'})
        self.official.assert_not_called()
        self.http.assert_not_called()

    def test_only_matching_timi_environment_reference_can_supply_key(self):
        self.settings['config'] = CONFIG + 'env_key="TIMICC_API_KEY"\n'
        self.config.write_text(self.settings['config'])
        self.update()
        self.assertEqual(self.read({'TIMICC_API_KEY': 'fixture-environment-key'})['kind'], 'balance')
        self.assertEqual(self.http.call_args.args[0].get_header('Authorization'), 'Bearer fixture-environment-key')
        self.config.write_text(CONFIG + 'env_key="UNRELATED_TOKEN"\n')
        self.http.reset_mock()
        self.assertEqual(self.read({'UNRELATED_TOKEN': 'fixture-unrelated-secret'}), {'kind': 'error', 'code': 'configuration'})
        self.http.assert_not_called()

    def test_currency_is_preserved_and_generic_env_key_never_overrides_selected_timi_key(self):
        self.settings['config'] = CONFIG + 'env_key="OPENAI_API_KEY"\n'
        self.config.write_text(self.settings['config'])
        self.update()
        self.http.side_effect = lambda *_args, **_kw: io.BytesIO(b'{"remaining":"38.40","unit":"EUR"}')
        self.assertEqual(self.read({'OPENAI_API_KEY': 'fixture-unrelated-openai-key'}),
                         {'kind': 'balance', 'amount': 38.4, 'currency': 'EUR'})
        self.assertEqual(self.http.call_args.args[0].get_header('Authorization'), 'Bearer synthetic-timi-key')

    def test_authentication_currency_size_and_malformed_config_fail_closed(self):
        self.http.side_effect = HTTPError('https://timicc.com/v1/usage', 403, 'secret server body', {}, None)
        self.assertEqual(self.read(), {'kind': 'error', 'code': 'authentication'})
        self.http.side_effect = HTTPError('https://timicc.com/v1/usage', 404, 'secret endpoint body', {}, None)
        self.assertEqual(self.read(), {'kind': 'error', 'code': 'endpoint'})
        self.http.side_effect = URLError('secret network detail')
        self.assertEqual(self.read(), {'kind': 'error', 'code': 'network'})
        for body in (b'{"balance":3,"unit":"fixture-private-field"}', b'{"remaining":true}', b'x' * (source.MAX_RESPONSE + 1)):
            self.http.side_effect = lambda *_args, **_kw: io.BytesIO(body)
            self.assertEqual(self.read(), {'kind': 'error', 'code': 'response'})
        self.config.write_text('malformed=[')
        self.assertEqual(self.read(), {'kind': 'error', 'code': 'configuration'})
        self.official.assert_not_called()

    def test_fake_cli_only_performs_initialize_and_rate_limits_and_drops_account_fields(self):
        fake = self.home / 'codex-fixture'
        fake.write_text(f'#!{sys.executable}\n' + '''import json, sys
assert sys.argv[1:] == ['app-server']
read = lambda: json.loads(sys.stdin.readline())
assert read()['method'] == 'initialize'
print('{"id":1,"result":{}}', flush=True)
assert read() == {'method':'initialized'}
assert read() == {'id':2,'method':'account/rateLimits/read'}
print('{"id":2,"result":{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1890000000},"secondary":{"usedPercent":66,"windowDurationMins":10080},"credits":{"balance":"secret"}}}}}', flush=True)
''')
        os.chmod(fake, 0o700)
        self.assertEqual(source.read_official(str(fake), self.home, self.codex_home, {}, 5), {'kind': 'windows', 'rows': [
            {'minutes': 300, 'remaining': 75, 'resetsAt': 1890000000},
            {'minutes': 10080, 'remaining': 34, 'resetsAt': None},
        ]})


if __name__ == '__main__':
    unittest.main(verbosity=2)
