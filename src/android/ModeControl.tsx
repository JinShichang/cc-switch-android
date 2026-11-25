import {useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useQueryClient} from '@tanstack/react-query';
import {invoke,isNative} from '../bridge';
import type {Provider} from '../core/types';
import type {AppMode,AppModeView,ProxyStack,GlobalProxyConfig,FailoverQueueItem} from '../vendor/types/proxy';
import {ModeTabs} from '../vendor/components/providers/mode/ModeTabs';
import {ModeDialog,type ModeDialogState} from '../vendor/components/providers/mode/ModeDialog';
import {StackSettingsSheet} from '../vendor/components/providers/mode/StackSettingsSheet';
import {RouteSettingsSheet} from '../vendor/components/providers/mode/RouteSettingsSheet';
import {Button} from '../vendor/components/ui/button';
import {Sheet,SheetContent,SheetHeader,SheetTitle} from '../vendor/components/ui/sheet';
import {Input} from '../vendor/components/ui/input';
import {Switch} from '../vendor/components/ui/switch';
import {AutoFailoverConfigPanel} from '../vendor/components/proxy/AutoFailoverConfigPanel';
import {providerNeedsRouting,supportsFailover,isOfficialAccount} from '../vendor/utils/providerCapabilities';
import {getRoutingReason} from '../vendor/utils/routingReason';
import {stackSubagentSettings,stackSubagentValue} from '../vendor/components/providers/mode/StackSubagentFields';
import type {Settings} from '../vendor/types';
import {queueMoveSortUpdates} from '../vendor/utils/queueSort';

export async function ensureRouterBackground(){
  const status=await invoke<{unrestricted:boolean;notifications:boolean}>('backgroundStatus');
  if(!status.unrestricted){
    const settings=window.confirm('本机路由与聚合需要 CC Switch 持续在后台运行。请关闭电池优化、允许后台活动，并在一加手机中取消后台限制。现在打开后台运行设置？');
    if(settings)await invoke('openBatterySettings');
  }
  await invoke('requestNotifications');
  await invoke('startRouter');
}

export function ModeControl({providers,onChanged,onView,onError,onApplyRequest}:{providers:Provider[];onChanged:()=>Promise<void>;onView:(mode:AppMode)=>void;onError:(message:string)=>void;onApplyRequest?:{providerId:string;nonce:number}|null}){
  const [mode,setMode]=useState<AppModeView>({mode:'direct',attached:false,routeProviderId:null,directProviderId:null});
  const [view,setView]=useState<AppMode>('direct');
  const [stack,setStack]=useState<ProxyStack>({active:false,members:[]});
  const [dialog,setDialog]=useState<ModeDialogState|null>(null);
  const [routeSettings,setRouteSettings]=useState(false),[stackSettings,setStackSettings]=useState(false);
  const [failover,setFailover]=useState(false),[busy,setBusy]=useState(false);
  const [queue,setQueue]=useState<FailoverQueueItem[]>([]),[global,setGlobal]=useState<GlobalProxyConfig|null>(null);
  const [moreSettings,setMoreSettings]=useState(false);
  const ready=useRef(false);
  const lastMode=useRef<AppMode>();
  const [settings,setSettings]=useState<Settings|null>(null);
  const {t}=useTranslation();
  const query=useQueryClient();
  const native=(command:string,payload:Record<string,unknown>={})=>invoke<any>('native',{command,payload});
  const refresh=async()=>{
    if(!isNative)return;
    const [mode,stack,failover,queue,config,settings]=await Promise.all([native('get_app_mode'),native('get_proxy_stack'),native('get_auto_failover_enabled'),native('get_failover_queue'),native('get_global_proxy_config'),native('get_settings')]);
    setMode(mode);setStack(stack);setFailover(failover);
    setQueue(queue);setGlobal(config);setSettings(settings);
    if(!ready.current||lastMode.current!==mode.mode){ready.current=true;lastMode.current=mode.mode;setView(mode.mode);onView(mode.mode);}
  };
  useEffect(()=>{refresh().catch(e=>onError(e.message));const event=()=>refresh().catch(()=>{});window.addEventListener('provider-data-changed',event);window.addEventListener('provider-switched',event);return()=>{window.removeEventListener('provider-data-changed',event);window.removeEventListener('provider-switched',event);};},[providers]);
  useEffect(()=>{if(!onApplyRequest)return;const provider=providers.find(p=>p.id===onApplyRequest.providerId);if(!provider)return;
    if(view==='direct'&&mode.mode==='direct'&&providerNeedsRouting('codex',provider))setDialog({kind:'needsRoute',providerId:provider.id,reason:getRoutingReason('codex',provider,t)??''});
    else if(view==='direct'&&mode.mode!=='direct')setDialog({kind:'exit',useProviderId:provider.id});
    else if(view!=='direct'&&mode.mode==='direct')setDialog({kind:'enter',target:view});
  },[onApplyRequest?.nonce]);
  const change=async(work:()=>Promise<unknown>)=>{
    setBusy(true);try{await work();await refresh();await onChanged();await query.invalidateQueries();}catch(e){onError((e as Error).message);throw e;}finally{setBusy(false);}
  };
  const moveQueue=(providerId:string,delta:-1|1)=>{
    const updates=queueMoveSortUpdates(queue,Object.fromEntries(providers.map(p=>[p.id,p])),providerId,delta);
    return updates?change(()=>native('update_provider_sort_order',{updates})):Promise.resolve();
  };
  const stale=stack.staleClients;
  return <section className="mobile-mode-control">
    <ModeTabs modes={['direct','route','stack']} active={mode.mode} view={view}
      onView={next=>{setView(next);onView(next);}}
      failover={view==='route'?{enabled:failover,disabled:busy,onChange:enabled=>void change(()=>native('set_auto_failover_enabled',{enabled})).catch(()=>{})}:undefined}
      onOpenRouteSettings={view==='route'?()=>setRouteSettings(true):undefined}
      onOpenStackSettings={view==='stack'?()=>setStackSettings(true):undefined}/>
    {view!==mode.mode&&<div className="mode-entry"><p>{view==='direct'?'回到直连后，写回直连供应商配置。':view==='route'?'通过本机路由转发请求，可按队列故障转移。':'多个供应商的模型合并到 Codex 模型菜单，选择后直达对应供应商。'}</p><Button disabled={busy||!isNative} onClick={()=>setDialog(view==='direct'?{kind:'exit'}:{kind:'enter',target:view})}>{view==='direct'?'回到直连…':view==='route'?'进入路由模式…':'进入聚合模式…'}</Button></div>}
    {view!=='direct'&&<p className="text-caption text-fg-2 px-3 py-2">本机中转需要允许 CC Switch 后台运行。切换后可以再重启 Codex 加载配置。</p>}
    {mode.mode!=='direct'&&stale&&(stale.auth||stale.others||stale.daemon)&&<div role="status" className="rounded-control bg-warning-soft px-3 py-2 text-caption text-warning-text">
      Codex 可能仍使用旧的模型列表或登录；请手动重启 Codex。
      <Button variant="quiet" size="compact" disabled={busy} onClick={()=>void change(()=>native('acknowledge_codex_stale_clients')).catch(()=>{})}>已重启，关闭提示</Button>
    </div>}
    {view==='stack'&&stack.notice==='routeOwnsCatalog'&&<Button variant="quiet" size="compact" disabled={busy} onClick={()=>{if(window.confirm('改用 CC Switch 生成的模型目录？将移除当前供应商自己指定的 model_catalog_json。'))void change(()=>native('adopt_codex_stack_catalog')).catch(()=>{});}}>改用聚合模型目录</Button>}
    {view==='stack'&&<div className="px-3 py-2 space-y-2">{providers.filter(p=>p.id!==mode.routeProviderId).map(provider=>{
      const member=stack.members.find(m=>m.providerId===provider.id);
      return <div className="flex flex-wrap items-center gap-2" key={provider.id}><span className="flex-1">{provider.name}{member?` · ${member.memberModels} 个模型`:''}</span>
        {!isOfficialAccount('codex',provider)&&<Button disabled={busy} variant="quiet" size="compact" onClick={()=>void change(()=>native('set_proxy_stack_member',{providerId:provider.id,enabled:!member})).catch(()=>{})}>{member?'移出聚合':'加入聚合'}</Button>}
        <Button disabled={busy} variant="quiet" size="compact" onClick={()=>void change(()=>native('set_proxy_route',{providerId:provider.id})).catch(()=>{})}>设为默认</Button></div>;
    })}{stack.notice&&<p role="status" className="text-caption">{stack.notice==='routeOwnsCatalog'?'默认供应商使用自己的模型目录，聚合模型暂不可见。':stack.notice==='officialModelsUnavailable'?'官方模型列表不可用，请先登录并读取官方模型列表。':'官方模型列表使用 Codex 提供的缓存；请检查模型和重启提示。'}</p>}</div>}
    {view==='route'&&failover&&<div className="px-3 py-2 space-y-2"><strong>故障转移队列</strong>{queue.map((item,index)=><div className="flex flex-wrap gap-2 items-center" key={item.providerId}><span className="flex-1">{index+1}. {item.providerName}</span>
      <Button variant="quiet" size="compact" disabled={busy||index===0} onClick={()=>void moveQueue(item.providerId,-1).catch(()=>{})}>上移</Button>
      <Button variant="quiet" size="compact" disabled={busy||index===queue.length-1} onClick={()=>void moveQueue(item.providerId,1).catch(()=>{})}>下移</Button>
      <Button variant="quiet" size="compact" disabled={busy} onClick={()=>void change(()=>native('remove_from_failover_queue',{providerId:item.providerId})).catch(()=>{})}>移出</Button></div>)}
      {providers.filter(p=>supportsFailover('codex',p)&&!queue.some(q=>q.providerId===p.id)).map(p=><Button variant="quiet" size="compact" disabled={busy} key={p.id} onClick={()=>void change(()=>native('add_to_failover_queue',{providerId:p.id})).catch(()=>{})}>加入 {p.name}</Button>)}</div>}
    <ModeDialog app="codex" state={dialog} active={mode.mode} providers={providers}
      directId={mode.directProviderId} eligibleIds={providers.map(p=>p.id)} defaultPick={mode.routeProviderId??mode.directProviderId}
      stackMembers={stack.members.map(member=>({id:member.providerId,name:providers.find(p=>p.id===member.providerId)?.name??member.providerId,models:member.memberModels}))}
      stackSubagent={settings?{models:stack.subagentModels??[],value:stackSubagentValue(settings)}:undefined}
      onClose={()=>setDialog(null)}
      onEnter={async(target,pick,subagent)=>{await change(async()=>{await ensureRouterBackground();if(subagent){const current=await native('get_settings');await native('save_settings',{settings:{...current,...stackSubagentSettings(subagent)}});}await native('setMode',{mode:target,providerId:pick});});setDialog(null);}}
      onExit={async(id)=>{await change(async()=>{await native('setMode',{mode:'direct'});if(id)await native('selectDirect',{providerId:id});await invoke('stopRouter');});setDialog(null);}}
      onSwitchDirect={id=>{void change(()=>native('selectDirect',{providerId:id})).then(()=>setDialog(null)).catch(()=>{});}}/>
    <RouteSettingsSheet app="codex" open={routeSettings} onOpenChange={setRouteSettings} onOpenSettings={()=>{setRouteSettings(false);setMoreSettings(true);}}/>
    <StackSettingsSheet open={stackSettings} onOpenChange={setStackSettings} models={stack.subagentModels??[]} routeOfficial={providers.find(p=>p.id===mode.routeProviderId)?.category==='official'}/>
    <Sheet open={moreSettings} onOpenChange={setMoreSettings}><SheetContent closeLabel="关闭路由设置" className="overflow-y-auto"><SheetHeader><SheetTitle>本机路由设置</SheetTitle></SheetHeader>{global&&<div className="space-y-4 py-4">
      <label className="block">监听地址<Input value={global.listenAddress} onChange={e=>setGlobal({...global,listenAddress:e.target.value})}/></label>
      <label className="block">监听端口<Input type="number" min={1} max={65535} value={global.listenPort} onChange={e=>setGlobal({...global,listenPort:Number(e.target.value)})}/></label>
      <label className="flex items-center gap-3">记录请求用量<Switch checked={global.enableLogging} onCheckedChange={enableLogging=>setGlobal({...global,enableLogging})}/></label>
      <Button disabled={busy} onClick={()=>void change(()=>native('update_global_proxy_config',{config:global})).catch(()=>{})}>保存</Button>
      <AutoFailoverConfigPanel appType="codex" />
    </div>}</SheetContent></Sheet>
  </section>;
}
