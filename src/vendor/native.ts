import {androidCommand} from '../android/commands';
export const invoke=<T=any>(command:string,args:Record<string,any>={}):Promise<T>=>androidCommand(command,args);
export class Channel<T>{onmessage:(value:T)=>void=()=>{};}
export type UnlistenFn=()=>void;
export async function listen<T>(name:string,handler:(event:{payload:T})=>void):Promise<UnlistenFn>{const fn=(e:Event)=>handler({payload:(e as CustomEvent).detail});window.addEventListener(name,fn);return ()=>window.removeEventListener(name,fn);}
export async function emit(name:string,payload?:unknown){window.dispatchEvent(new CustomEvent(name,{detail:payload}));}
export const getVersion=async()=> '0.3.0';
export const getName=async()=> 'CC Switch Android';
export type Update=any;
export async function check(_options?:unknown):Promise<Update|null>{return null;}

export const isTauri=()=>!!window.CCSwitch;
