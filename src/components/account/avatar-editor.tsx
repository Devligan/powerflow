"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { AVATAR_SIZE } from "@/lib/profile";

/**
 * Crop a picture to its centred square and scale it to AVATAR_SIZE.
 * Re-encoding through a canvas also drops the file's metadata (EXIF, with
 * any GPS position a phone wrote into it) before anything leaves the browser.
 */
async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE
  );
  bitmap.close();
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // Browsers that cannot encode WebP hand back a PNG instead, which is fine.
  const blob = (await encode("image/webp", 0.9)) ?? (await encode("image/png"));
  if (!blob) throw new Error("That picture could not be processed.");
  return blob;
}

export function AvatarEditor({
  initialUrl,
  name,
  onChange,
}: {
  initialUrl: string | null;
  name: string;
  onChange?: (url: string | null) => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function settle(next: string | null) {
    setUrl(next);
    onChange?.(next);
    router.refresh();
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const blob = await toAvatarBlob(file).catch(() => {
        throw new Error("That file is not a picture this browser can open.");
      });
      const body = new FormData();
      body.append("file", blob, "avatar");
      const res = await fetch("/api/account/avatar", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");
      settle(data.avatarUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/avatar", { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not remove the picture");
      settle(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the picture");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar url={url} name={name} size={64} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Working…" : url ? "Change picture" : "Upload picture"}
          </button>
          {url && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={remove}>
              Remove
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            aria-label="Profile picture"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </div>
        <p className="text-[11px] t-mute">
          Cropped to a square. Shown beside your name on the standings.
        </p>
        {error && (
          <p role="alert" className="text-[11px] t-short">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
