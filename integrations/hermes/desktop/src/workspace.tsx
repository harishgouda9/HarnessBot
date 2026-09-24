import { Button, ErrorState, Loader, useQuery } from '@hermes/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Harness, KEYS, type PluginCtx } from './harness.ts';
import { canUseWebview, productUrl } from './logic.ts';

/**
 * The /harnessbot page: the full HarnessBot product, inside Hermes Desktop.
 *
 * Hermes Desktop's own browser pane is a `<webview>` guest (webviewTag is on).
 * An <iframe> from `app://hermes` to `http://127.0.0.1:8799` is the thing
 * Chromium sometimes blanks; the webview is the same door the preview pane
 * uses for localhost. Fall back to iframe, then to an error with Retry.
 */

function ProductFrame({ url, onOpenExternal }: { url: string; onOpenExternal?: (url: string) => void }) {
  const webview = canUseWebview((tag) => (typeof document === 'undefined' ? null : document.createElement(tag)));
  const guest = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setFailed(null);
    const el = guest.current;
    if (!el) return;
    const fail = (event: Event): void => {
      const detail = event as Event & { errorDescription?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      setFailed(detail.errorDescription || 'the page failed to load');
    };
    el.addEventListener('did-fail-load', fail);
    return () => el.removeEventListener('did-fail-load', fail);
  }, [url, generation, webview]);

  if (failed) {
    return (
      <ErrorState
        title="HarnessBot did not load"
        description={`${failed} (${url})`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setFailed(null);
                setGeneration((n) => n + 1);
              }}
            >
              Try again
            </Button>
            {onOpenExternal ? (
              <Button variant="ghost" onClick={() => onOpenExternal(url)}>
                Open in a window
              </Button>
            ) : null}
          </div>
        }
      />
    );
  }

  const fill = { className: 'absolute inset-0 h-full w-full border-0', src: url };

  return (
    <div className="relative h-full min-h-0 w-full" key={generation}>
      {webview ? (
        // Electron custom element. JSX would not parse in a disk plugin; the
        // compiled bundle emits createElement('webview', …).
        <webview
          ref={guest as never}
          title="HarnessBot"
          {...fill}
          allowpopups={true}
          partition="persist:harnessbot"
        />
      ) : (
        <iframe title="HarnessBot" {...fill} allow="clipboard-read; clipboard-write; microphone" onError={() => setFailed('the frame was blocked')} />
      )}
    </div>
  );
}

export function Workspace({ ctx }: { ctx: PluginCtx }) {
  const harness = useMemo(() => new Harness(ctx), [ctx]);
  const status = useQuery({
    queryKey: KEYS.status,
    queryFn: async () => {
      const result = await harness.ensureRunning();
      if (!result.ok) throw new Error(result.error || 'HarnessBot failed to start');
      return result;
    },
    refetchInterval: 12_000,
  });

  if (status.isLoading) return <Loader label="Starting HarnessBot…" />;
  const url = productUrl(status.data?.url);
  if (status.error || !url) {
    return (
      <ErrorState
        title="HarnessBot is not answering"
        description={String((status.error as Error | undefined)?.message ?? status.error ?? 'No URL was reported.')}
        action={<Button onClick={() => void status.refetch()}>Try again</Button>}
      />
    );
  }

  return (
    <ProductFrame
      url={url}
      onOpenExternal={(href) => {
        void ctx.os?.openExternal?.(href);
      }}
    />
  );
}
