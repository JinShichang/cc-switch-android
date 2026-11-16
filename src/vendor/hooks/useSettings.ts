import {useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useSettingsQuery} from '../lib/query';
import {invoke} from '../native';
import type {Settings} from '../types';
export type SettingsFormState=Settings;
export function useSettings(){const {data,isLoading}=useSettingsQuery(); const q=useQueryClient();const draft=useRef<Partial<Settings>>({});return {settings:data??null,isLoading,updateSettings:(v:Partial<Settings>)=>{draft.current={...draft.current,...v}},autoSaveSettings:async(v:Partial<Settings>)=>{const saved=await invoke<Settings>('save_settings',{settings:{...data,...draft.current,...v}});q.setQueryData(['settings'],saved);return {requiresRestart:false}}};}
