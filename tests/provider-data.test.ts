import test from 'node:test';
import assert from 'node:assert/strict';
import {newProvider,validateProvider,exportProviders,importProviders,redactConfig} from '../src/core/codex.ts';

test('provider export/import preserves complete raw TOML, auth and model metadata',()=>{
  const provider=newProvider();provider.name='Test provider';
  provider.settingsConfig={auth:{OPENAI_API_KEY:'TEST_ONLY_KEY'},config:'model_provider="custom"\nmodel="gpt-5.5"\n[model_providers.custom]\nname="custom"\nbase_url="https://example.invalid/v1"\nwire_api="responses"\n[mcp_servers.android]\ncommand="/usr/local/bin/mcp-android"\n',modelCatalog:{models:[{model:'gpt-5.5',displayName:'Test model',contextWindow:128000,defaultReasoningLevel:'high'}]}};
  provider.historyFilter=true;provider.meta={billingMultiplier:'2.5'};
  const output=importProviders(exportProviders([provider],true));
  assert.equal(output.providers[0].settingsConfig.config,provider.settingsConfig.config);
  assert.equal(output.providers[0].settingsConfig.auth.OPENAI_API_KEY,'TEST_ONLY_KEY');
  assert.equal(output.providers[0].historyFilter,true);assert.equal(output.providers[0].meta?.billingMultiplier,'2.5');
});
test('key-free export and display redact bearer values and authentication objects',()=>{
  const provider=newProvider();provider.name='Test provider';provider.settingsConfig.auth={OPENAI_API_KEY:'TEST_ONLY_KEY'};
  provider.settingsConfig.config+='\nexperimental_bearer_token="TEST_ONLY_BEARER"\n';
  const output=exportProviders([provider],false);assert(!output.includes('TEST_ONLY_KEY'));assert(!output.includes('TEST_ONLY_BEARER'));assert(!redactConfig(provider.settingsConfig.config).includes('TEST_ONLY_BEARER'));
});
test('legacy Android login policy is retired during import',()=>{
  const provider=newProvider();provider.name='Test';provider.meta={androidLoginPolicy:'preserve'};
  const value=validateProvider(provider);assert.equal(value.meta?.androidLoginPolicy,undefined);
});
