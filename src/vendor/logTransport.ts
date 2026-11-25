// Messages reaching this transport have already passed upstream redaction.
import {invoke,isNative} from '../bridge';
export async function info(message:string,_options?:unknown){if(isNative)await invoke('nativeLog',{level:'info',message});}
export async function error(message:string,_options?:unknown){if(isNative)await invoke('nativeLog',{level:'error',message});}
