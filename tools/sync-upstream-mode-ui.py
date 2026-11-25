from pathlib import Path
import json
project=Path(__file__).resolve().parents[1]
source=project.parent/'references/cc-switch/src'
files=['components/providers/mode/ModeTabs.tsx','components/providers/mode/ModeDialog.tsx','components/providers/mode/StackSubagentFields.tsx','components/providers/mode/StackSettingsSheet.tsx','components/providers/mode/CodexPauseOfficialLogin.tsx','components/providers/mode/RouteSettingsSheet.tsx','components/proxy/AutoFailoverConfigPanel.tsx','components/settings/SettingsLayout.tsx','components/ui/alert.tsx','lib/api/failover.ts','lib/query/failover.ts','lib/frontendLogger.ts','utils/routingReason.ts','components/ConfirmDialog.tsx']
for name in files:
    path=project/'src/vendor'/name
    path.parent.mkdir(parents=True,exist_ok=True)
    text=(source/name).read_text(encoding='utf-8').replace('"@/','"@/vendor/').replace("'@/","'@/vendor/")
    if name=='lib/frontendLogger.ts':text=text.replace('"@tauri-apps/plugin-log"','"@/vendor/logTransport"')
    if name=='lib/api/failover.ts':text=text.replace('"@tauri-apps/api/core"','"@/vendor/native"')
    path.write_text(text,encoding='utf-8')
local=project/'src/i18n/zh.json'
translation=json.loads(local.read_text(encoding='utf-8'))
upstream=json.loads((source/'i18n/locales/zh.json').read_text(encoding='utf-8'))
def merge(a,b):
    for key,value in b.items():
        if isinstance(a.get(key),dict) and isinstance(value,dict):merge(a[key],value)
        else:a[key]=value
for name in ('mode','proxy','failover','settings','common'):
    merge(translation.setdefault(name,{}),upstream.get(name,{}))
local.write_text(json.dumps(translation,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
# Keep the original queue reorder function without pulling unrelated UI.
presentation=(source/'components/providers/presentation.ts').read_text(encoding='utf-8')
queue=presentation[presentation.index('export function queueMoveSortUpdates('):presentation.index('export interface SwitchModeInput')]
(project/'src/vendor/utils/queueSort.ts').write_text('import type { Provider } from "../types";\n\n'+queue,encoding='utf-8')
print('Copied upstream mode controls and dialogs with import paths adapted.')
