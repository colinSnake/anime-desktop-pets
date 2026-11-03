#!/usr/bin/env python3
"""合成配置和HTTP响应验证；禁止真实账号/网络额度请求。"""
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'apps/pet-runtime/bailong'), str(ROOT / '.local/pet-build/generated-source/app')]
import dragon_quota as adapter

CONFIG = 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://timicc.com"\nrequires_openai_auth=false\n'
SCRIPT = '''({request: {url: "{{baseUrl}}/v1/usage", method: "GET", headers: {"Authorization": "Bearer {{apiKey}}"}}, extractor: function(response){return response;}})'''


class ProviderQuotaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / 'config.toml').write_text(CONFIG)
        self.db = self.home / 'cc-switch.db'
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute('CREATE TABLE providers(app_type TEXT,is_current INTEGER,settings_config TEXT,meta TEXT)')
        self.settings = dict(config=CONFIG, auth=dict(OPENAI_API_KEY='fixture-private-key'))
        self.meta = dict(usage_script=dict(enabled=True, language='javascript', code=SCRIPT))
        self.update()

    def tearDown(self):
        self.tmp.cleanup()

    def update(self):
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute('DELETE FROM providers')
            connection.execute('INSERT INTO providers VALUES (?,?,?,?)', ('codex', 1, json.dumps(self.settings), json.dumps(self.meta)))
            connection.commit()

    def request(self):
        return adapter.provider_request(self.home, self.home)

    def test_official_account_retains_official_reader(self):
        (self.home / 'config.toml').write_text('model_provider="openai"')
        self.assertIsNone(self.request())
        with patch.object(adapter, 'provider_request', return_value=None), patch.object(adapter, 'official_read', return_value={'official': True}) as official:
            self.assertEqual(adapter.read_quota(log_path=False), {'official': True})
            official.assert_called_once()

    def test_matching_config_uses_read_only_endpoint(self):
        before = self.db.read_bytes()
        request = self.request()
        self.assertEqual(request.full_url, 'https://timicc.com/v1/usage')
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.get_header('Authorization'), 'Bearer fixture-private-key')
        self.assertEqual(before, self.db.read_bytes())

    def test_mismatched_service_never_receives_credentials(self):
        self.settings['config'] = CONFIG.replace('timicc.com', 'other.invalid'); self.update()
        with self.assertRaises(adapter.QuotaFailure): self.request()

    def test_unrecognized_or_disabled_usage_scripts_are_not_executed(self):
        for value in (SCRIPT.replace('/v1/usage', '/untrusted'), SCRIPT.replace('GET', 'POST'), SCRIPT.replace('Bearer {{apiKey}}', 'Bearer literal')):
            self.meta['usage_script']['code'] = value; self.update()
            with self.assertRaises(adapter.QuotaFailure): self.request()
        self.meta['usage_script'].update(code=SCRIPT, enabled=False); self.update()
        with self.assertRaises(adapter.QuotaFailure): self.request()

    def test_unsupported_provider_has_explicit_message(self):
        for base in ('https://other.invalid', 'http://timicc.com', 'https://timicc.com:bad', 'https://timicc.com/v1'):
            (self.home / 'config.toml').write_text(CONFIG.replace('https://timicc.com', base))
            with self.assertRaises(adapter.QuotaFailure) as result: self.request()
            self.assertEqual(result.exception.code, 'provider_unsupported')

    def read(self, data=None, error=None):
        opener = Mock()
        if error: opener.open.side_effect = error
        else: opener.open.return_value = io.BytesIO(json.dumps(data).encode())
        request = self.request()
        with patch.object(adapter, 'provider_request', return_value=request), patch.object(adapter, 'build_opener', return_value=opener):
            return adapter.read_quota(log_path=False)

    def test_balance_preserves_amount_unit_and_never_becomes_percent(self):
        for data in ({'remaining': 12.5, 'unit': 'USD'}, {'quota': {'remaining': '12.5', 'unit': 'USD'}}, {'balance': 12.5}):
            row = adapter.quota_windows(self.read(data))[0]
            self.assertEqual((row['remaining'], row['kind'], row['unit']), (12.5, 'balance', 'USD'))
            self.assertIsNone(row['resetsAt'])
        self.assertEqual(adapter.quota_windows({'rateLimits': {'primary': {'usedPercent': 25}}})[0]['remaining'], 75)

    def test_invalid_balance_and_api_error_payloads_fail_clearly(self):
        for data in ({}, {'error': 'fixture-private-key'}, {'remaining': True}, {'remaining': 'nan'}, {'remaining': 4, 'unit': '\n'}, {'remaining': 1, 'is_active': False}):
            with self.assertRaises(adapter.QuotaFailure) as result: self.read(data)
            self.assertNotIn('fixture-private-key', str(result.exception))

    def test_redirects_auth_failures_and_not_found_are_sanitized(self):
        self.assertIsNone(adapter.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
        for code, expected in ((401, 'provider_authentication'), (403, 'provider_authentication'), (404, 'provider_unsupported'), (302, 'provider_http')):
            with self.assertRaises(adapter.QuotaFailure) as result:
                self.read(error=HTTPError('https://timicc.com/v1/usage', code, 'private body', {}, None))
            self.assertEqual(result.exception.code, expected)
            self.assertNotIn('private body', str(result.exception))

    def test_oversized_response_is_rejected(self):
        request = self.request()
        with patch.object(adapter, 'MAX_RESPONSE', 4), patch.object(adapter, 'provider_request', return_value=request):
            with self.assertRaises(adapter.QuotaFailure): self.read({'remaining': 1})


if __name__ == '__main__':
    unittest.main(verbosity=2)
