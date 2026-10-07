"use client";
import { memo, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { datasetDownloadUrl, downloadFile } from "@/lib/api";
const textAnimation = { animation: "fadeIn", duration: 150, stagger: 0 } as const;

export const Markdown = memo(function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [error, setError] = useState("");
  return (
    <>
    <MessageResponse
      skipHtml
      isAnimating={streaming}
      animated={textAnimation}
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
});
