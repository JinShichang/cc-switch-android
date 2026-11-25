"""Update original usage/session/auth code; retain Android imports and layout."""
from pathlib import Path
import json
project=Path(__file__).resolve().parents[1]
source=project.parent/'references/cc-switch/src'
files=['components/sessions/SessionManagerPage.tsx','components/usage/UsagePage.tsx',
       'hooks/useSessionSearch.ts','hooks/useSessionContentSearch.ts',
       'components/providers/forms/CodexOAuthSection.tsx',
       'components/providers/forms/hooks/useManagedAuth.ts',
       'components/providers/forms/hooks/useCodexOauth.ts',
       'components/providers/forms/ManagedAccountRemoveDialog.tsx',
       'components/settings/auth/ManagedAccountsGroup.tsx',
       'components/CodexOauthAccountQuota.tsx','lib/authLoginLink.ts']
for name in files:
    text=(source/name).read_text(encoding='utf-8').replace('"@/','"@/vendor/').replace("'@/","'@/vendor/")
    text=text.replace('"@tauri-apps/api/event"','"@/vendor/native"').replace('"@tauri-apps/api/core"','"@/vendor/native"')
    target=project/'src/vendor'/name
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(text,encoding='utf-8',newline='\n')
locale=project/'src/i18n/zh.json'
current=json.loads(locale.read_text(encoding='utf-8'))
original=json.loads((source/'i18n/locales/zh.json').read_text(encoding='utf-8'))
for key in ['sessionManager','sessions','authCenter','codexOauth','managedAuth','codexConfig','usage','usageScript']:
    if key in original:current[key]=original[key]
locale.write_text(json.dumps(current,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Updated original session, usage and Codex auth UI from pinned upstream')
