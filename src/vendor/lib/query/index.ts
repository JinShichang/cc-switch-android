import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {invoke} from '../../native';
import {sessionsApi} from '../api/sessions';
import type {Settings,SessionMeta} from '../../types';
export {useProvidersQuery} from './queries';
export const piKeys={all:['pi'],sessions:['pi','sessions'],sessionDiscovery:['pi','discovery']};
export const useSettingsQuery=()=>useQuery<Settings>({queryKey:['settings'],queryFn:()=>invoke('get_settings'),staleTime:30000});
export const useSessionsQuery=()=>useQuery<SessionMeta[]>({queryKey:['sessions'],queryFn:()=>sessionsApi.list(),staleTime:30000});
export const useDeleteSessionMutation=()=>{const q=useQueryClient();return useMutation({mutationFn:sessionsApi.delete,onSuccess:()=>q.invalidateQueries({queryKey:['sessions']})})};
