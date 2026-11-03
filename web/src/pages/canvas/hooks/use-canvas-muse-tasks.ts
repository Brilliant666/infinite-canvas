import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { getMuseImageTaskSource, MuseImageTaskRejectedError, submitMuseImageTask, waitForMuseImageTask } from "@/services/api/image";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { flushCanvasStorage, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType, type CanvasMuseImageTask, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

export function canvasMuseTasks(config: AiConfig, prompt: string, references: ReferenceImage[], originId: string, slots: (string | undefined)[] = [undefined]) {
    const source = getMuseImageTaskSource(config);
    if (!source) return undefined;
    const { model, size, quality, background, systemPrompt } = config;
    const inputs = references.map((ref) => ref.storageKey ? { ...ref, dataUrl: "", url: undefined } : { ...ref });
    return slots.map((slotId): CanvasMuseImageTask => ({
        key: nanoid(), source, config: { model, size, quality, background, systemPrompt }, prompt, references: inputs, originId, slotId,
    }));
}

// A copied node does not own the original requests.
export function detachCanvasMuseTasks(node: CanvasNodeData): CanvasNodeData {
    const meta = node.metadata;
    if (!meta?.museImageTasks?.length) return node;
    return {
        ...node,
        metadata: {
            ...meta, museImageTasks: undefined, status: meta.content ? "success" : "idle", errorDetails: undefined,
            images: meta.images?.filter((slot) => slot.status === "success"),
        },
    };
}

function finishNode(node: CanvasNodeData, task: CanvasMuseImageTask, image?: UploadedImage, error?: string, paused = false): CanvasNodeData {
    const meta = node.metadata!;
    const tasks = (meta.museImageTasks || []).flatMap((t) => t.key !== task.key ? [t] : paused ? [{ ...t, paused: true }] : []);
    const images = meta.images?.map((slot) => slot.id !== task.slotId ? slot : image
        ? { ...slot, status: "success" as const, content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, errorDetails: undefined }
        : { ...slot, status: "error" as const, errorDetails: error });
    const show = image && (!task.slotId || !meta.primaryImageId || meta.primaryImageId === task.slotId);
    const size = show && image && node.type === CanvasNodeType.Image && !meta.freeResize ? fitNodeSize(image.width, image.height, node.width, node.height) : null;
    const hasImage = Boolean(image || meta.content);
    return {
        ...node,
        ...(size ? { ...size, position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 } } : {}),
        metadata: {
            ...meta, ...(show && image ? { ...imageMetadata(image), primaryImageId: task.slotId } : {}),
            images, museImageTasks: tasks.length ? tasks : undefined,
            status: tasks.some((item) => !item.paused) ? "loading" : hasImage ? "success" : "error",
            errorDetails: error || (tasks.some((item) => item.paused) ? meta.errorDetails : undefined),
        },
    };
}

export function useCanvasMuseTasks(projectId: string, loaded: boolean, nodes: CanvasNodeData[], config: AiConfig, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>, onError: (message: string) => void) {
    const workers = useRef(new Map<string, AbortController>());
    useEffect(() => () => {
        workers.current.forEach((c) => c.abort());
        workers.current.clear();
    }, [projectId]);
    useEffect(() => {
        if (!loaded) return;
        const live = new Set<string>();
        for (const node of nodes) for (const task of node.metadata?.museImageTasks || []) {
            if (task.paused) continue;
            const workerId = [projectId, node.id, task.key, task.taskId || ""].join("/");
            live.add(workerId);
            if (workers.current.has(workerId)) continue;
            const current = (n: CanvasNodeData) => n.id === node.id && n.metadata?.museImageTasks?.some((t) => t.key === task.key && t.taskId === task.taskId && !t.paused);
            if (!useCanvasStore.getState().openProject(projectId)?.nodes.some(current)) continue;
            const controller = new AbortController();
            workers.current.set(workerId, controller);
            const { signal } = controller;
            const settle = (image?: UploadedImage, error?: string, paused = false) => setNodes((prev) => {
                if (!prev.some(current)) return prev;
                const next = prev.map((n) => current(n) ? finishNode(n, task, image, error, paused) : n);
                const root = next.find((n) => n.id === node.id)!;
                if (task.originId === node.id || next.some((n) => n.metadata?.museImageTasks?.some((t) => t.originId === task.originId && !t.paused))) return next;
                return next.map((n) => n.id === task.originId && n.type === CanvasNodeType.Config && n.metadata?.status === "loading"
                    ? { ...n, metadata: { ...n.metadata, status: root.metadata?.status, errorDetails: root.metadata?.errorDetails } } : n);
            });
            const run = async () => {
                // The canvas save effect ran first. Flush both node and slot identity before contacting Muse.
                await flushCanvasStorage();
                signal.throwIfAborted();
                const original = { ...config, ...task.config, count: "1" };
                if (!task.taskId) {
                    const refs = await Promise.all(task.references.map(async (ref) => ({ ...ref, dataUrl: await resolveImageUrl(ref.storageKey, ref.dataUrl || ref.url) })));
                    if (refs.some((ref) => !ref.dataUrl)) throw new Error("原任务的参考图不可用。");
                    const id = await submitMuseImageTask(original, task.source, task.prompt, refs, task.key, { signal });
                    signal.throwIfAborted();
                    setNodes((prev) => prev.map((n) => current(n) ? { ...n, metadata: { ...n.metadata, museImageTasks: n.metadata!.museImageTasks!.map((t) => t.key === task.key ? { ...t, taskId: id } : t) } } : n));
                    return;
                }
                const result = await waitForMuseImageTask(original, task.source, task.taskId, { signal });
                signal.throwIfAborted();
                if (result.status === "failed") { settle(undefined, result.error); onError(result.error); return; }
                const uploaded = await uploadImage(result.image.dataUrl, { signal });
                signal.throwIfAborted();
                settle(uploaded);
            };
            void run().catch((e) => {
                if (signal.aborted) return;
                const terminal = e instanceof MuseImageTaskRejectedError;
                const reason = e instanceof Error ? e.message : "请求失败";
                const detail = terminal ? reason : `${reason}。已保留原任务，刷新或点击重试可继续查询。`;
                settle(undefined, detail, !terminal);
                onError(detail);
            });
        }
        for (const [key, controller] of workers.current) if (!live.has(key)) {
            controller.abort();
            workers.current.delete(key);
        }
    }, [projectId, loaded, nodes, config, setNodes, onError]);
}
