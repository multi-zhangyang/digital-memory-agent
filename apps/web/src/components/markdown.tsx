"use client";
import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { datasetDownloadUrl, downloadFile } from "@/lib/api";
export function Markdown({ content }: { content: string }) {
  const [error, setError] = useState("");
  return (
    <>
    <MessageResponse
      skipHtml
      components={{
        img: () => null,
        a: ({ href, children }) => (
          <a
            href={
              datasetDownloadUrl(href) || (href?.startsWith("http://") || href?.startsWith("https://")
                ? href
                : undefined)
            }
            download={datasetDownloadUrl(href) ? true : undefined}
            onClick={(event) => {
              const url = datasetDownloadUrl(href);
              if (!url) return;
              event.preventDefault(); setError("");
              const kind = url.split("/").at(-1)!;
              void downloadFile(url.slice(4), kind + (kind === "manifest" ? ".json" : ".jsonl"))
                .catch((failure) => setError(failure instanceof Error ? failure.message : "下载失败"));
            }}
            target={datasetDownloadUrl(href) ? undefined : "_blank"}
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </MessageResponse>
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    </>
  );
}
