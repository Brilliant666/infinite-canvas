import i18n from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { MuseImageTaskRejectedError, submitMuseImageTask, waitForMuseImageTask } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import type { GenerationLog, MuseSlot } from "./index";

export async function runMuseImageBatch(log: GenerationLog, signal: AbortSignal, save: (record: GenerationLog) => Promise<void>) {
    const batch = log.muse!;
    const cfg = { ...useConfigStore.getState().config, ...log.config, model: log.model, background: batch.background, systemPrompt: batch.systemPrompt, count: "1" };
    let writes = Promise.resolve();
    const persist = () => {
        log.durationMs = Date.now() - log.createdAt;
        log.images.sort((a,b) => batch.slots.findIndex(s => s.imageId === a.id) - batch.slots.findIndex(s => s.imageId === b.id));
        log.successCount = log.images.length;
        log.failCount = batch.slots.filter(slot => slot.failed).length;
        log.status = batch.slots.some(slot => !slot.imageId && !slot.failed) ? "pending" : log.successCount ? "success" : "failed";
        const record = { ...log, images: [...log.images] };
        record.muse = { ...batch, slots: batch.slots.map(slot => ({...slot})) };
        writes = writes.then(() => save(record));
        return writes;
    };
    const runSlot = async (slot: MuseSlot) => {
        if (slot.imageId || slot.failed) return;
        try {
            slot.error = undefined;
            if (!slot.taskId) {
                slot.taskId = await submitMuseImageTask(cfg, batch.source, log.prompt, log.references, slot.key, { signal });
                await persist();
            }
            const state = await waitForMuseImageTask(cfg, batch.source, slot.taskId, { signal });
            if (state.status === "failed") {
                slot.failed = true;
                slot.error = state.error;
            } else {
                const file = await uploadImage(state.image.dataUrl, { signal });
                slot.imageId = state.image.id;
                log.images.push({ id: state.image.id, dataUrl: file.url, storageKey: file.storageKey, durationMs: Date.now() - log.createdAt,
                    width: file.width, height: file.height, bytes: file.bytes, mimeType: file.mimeType });
            }
        } catch (error) {
            if (signal.aborted) throw error;
            slot.failed = error instanceof MuseImageTaskRejectedError;
            slot.error = error instanceof Error ? error.message : i18n.t("workbench.generationFailed");
        }
        await persist();
    };
    await Promise.all(batch.slots.map(runSlot));
}
