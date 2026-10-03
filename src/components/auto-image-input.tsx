"use client";
import { useEffect, useRef, useState } from "react";

/** Resize before upload so large camera images also fit the hosting request limit. */
export function AutoImageInput({ name, ru, logo = false }: { name: string; ru: boolean; logo?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const blocked = useRef(false);
  const generation = useRef(0);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const form = ref.current?.form;
    const guard = (e: Event) => { if (blocked.current) { e.preventDefault(); e.stopImmediatePropagation(); } };
    form?.addEventListener("submit", guard, true);
    return () => form?.removeEventListener("submit", guard, true);
  }, []);
  async function prepare() {
    const input = ref.current, file = input?.files?.[0], version = ++generation.current;
    if (!input || !file) { blocked.current = false; setStatus(""); return; }
    blocked.current = true;
    setStatus(ru ? "Подготавливаем изображение…" : "Preparing image…");
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const max = logo ? 512 : 1600;
      const ratio = Math.min(1, max / image.naturalWidth, max / image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = logo ? 512 : Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = logo ? 512 : Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas");
      const width = Math.max(1, Math.round(image.naturalWidth * ratio)), height = Math.max(1, Math.round(image.naturalHeight * ratio));
      context.drawImage(image, (canvas.width-width)/2, (canvas.height-height)/2, width, height);
      const limit = logo ? 256*1024 : 1024*1024;
      let blob: Blob | null = null;
      for (const quality of [0.9, 0.8, 0.65, 0.45]) {
        blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", quality));
        if (blob && blob.size <= limit) break;
      }
      if (!blob || blob.size > limit) throw new Error("conversion");
      if (version !== generation.current) return;
      const data = new DataTransfer();
      data.items.add(new File([blob], name+".webp", {type: blob.type}));
      input.files = data.files;
      blocked.current = false;
      setStatus(ru ? "Изображение готово к загрузке" : "Image ready to upload");
    } catch {
      if (version !== generation.current) return;
      input.value = "";
      blocked.current = true;
      setStatus(ru ? "Не удалось прочитать изображение. Выберите фотографию или изображение PNG, JPEG, WebP." : "Could not read the image. Choose a photo or a PNG, JPEG or WebP image.");
    } finally { URL.revokeObjectURL(url); }
  }
  return <><input ref={ref} name={name} type="file" accept="image/*" onChange={prepare}/><span role="status" className="small muted">{status}</span></>;
}
