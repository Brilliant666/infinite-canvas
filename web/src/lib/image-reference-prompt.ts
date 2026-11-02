import type { ReferenceImage } from "@/types/image";

import i18n from "@/i18n";

export function imageReferenceLabel(index: number, lng?: string) {
    return i18n.t("imageReferences.label", { index: index + 1, lng });
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[], lng?: string) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index, lng));
    return i18n.t("imageReferences.promptPrefix", { labels: labels.join(i18n.t("imageReferences.separator", { lng })), prompt: text, lng });
}
