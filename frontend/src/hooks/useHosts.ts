import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { HostService, Host } from "../../bindings/terminator-desktop/backend/internal/services/blob";
import { handleAppError } from "@/lib/error";

export const HOSTS_QUERY_KEY = ["hosts"];

export function useHosts() {
    return useQuery({
        queryKey: HOSTS_QUERY_KEY,
        queryFn: async () => HostService.GetAll(),
    });
}

export function useSaveHost() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (host: Host) => HostService.Save(host),
        onSuccess: () => queryClient.invalidateQueries({queryKey: HOSTS_QUERY_KEY}),
        onError: (error) => {
            handleAppError(error);
        },
    });
}

export function useDeleteHost() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            // 删除前先解除其他主机对它的跳板引用：残留的 jumpHostId 会让这些主机
            // 在连接时静默退化为直连目标机（resolveJumpHostChain 找不到即返回 undefined），
            // 与用户配置的链路不符
            const hosts = await HostService.GetAll();
            const dependents = hosts.filter((h) => h.jumpHostId === id);
            for (const dep of dependents) {
                await HostService.Save({ ...dep, jumpHostId: "" });
            }
            await HostService.Delete(id);
        },
        onSuccess: () => queryClient.invalidateQueries({queryKey: HOSTS_QUERY_KEY}),
        onError: (error) => {
            handleAppError(error);
        },
    });
}