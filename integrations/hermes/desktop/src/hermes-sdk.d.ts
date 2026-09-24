/**
 * The slice of `@hermes/plugin-sdk` this plugin uses.
 *
 * Hermes ships the real types inside its own app, which is not a dependency here
 * and cannot become one — the SDK is injected at load time as a blob shim, not
 * installed. So this is a hand-written declaration of exactly what we import,
 * kept deliberately narrow: adding a name here is a decision to depend on it, and
 * a name that is wrong fails loudly at load rather than quietly at runtime.
 *
 * Components are typed loosely. The value of typechecking this plugin is in our
 * own logic — query keys, message shapes, activity mapping — not in re-deriving
 * Hermes' prop types from the outside.
 */
declare module '@hermes/plugin-sdk' {
  import type { ComponentType, ReactNode } from 'react';

  // Contribution areas. Values are plain strings by contract.
  export const PANES_AREA: string;
  export const ROUTES_AREA: string;
  export const SIDEBAR_NAV_AREA: string;
  export const PALETTE_AREA: string;
  export const CHAT_EMPTY_AREA: string;
  export const KEYBINDS_AREA: string;
  export const THEMES_AREA: string;
  export const STATUSBAR_AREAS: { left: string; right: string };
  export const TITLEBAR_AREAS: { center: string; left: string; right: string };

  // UI kit.
  export const Badge: ComponentType<any>;
  export const Button: ComponentType<any>;
  export const EmptyState: ComponentType<any>;
  export const ErrorState: ComponentType<any>;
  export const GlyphSpinner: ComponentType<any>;
  export const Loader: ComponentType<any>;
  export const Popover: ComponentType<any>;
  export const PopoverContent: ComponentType<any>;
  export const PopoverTrigger: ComponentType<any>;
  export const ScrollArea: ComponentType<any>;
  export const SearchField: ComponentType<any>;
  export const Separator: ComponentType<any>;
  export const StatusDot: ComponentType<any>;
  export const Streamdown: ComponentType<{ children?: ReactNode }>;
  export const Textarea: ComponentType<any>;
  export const Tip: ComponentType<any>;

  // Utilities.
  export function cn(...parts: unknown[]): string;
  export function compactNumber(value: number): string;
  export function formatAgo(at: number): string;

  /** The host door. Only the members this plugin actually calls. */
  export const host: {
    navigate(route: string): void;
    notify(input: { kind: string; message: string; title?: string }): void;
    openSession(id: string, opts?: Record<string, unknown>): void;
    os?: { openExternal?(url: string): void };
  };

  // React Query, shared with the app so invalidation crosses plugin boundaries.
  export interface QueryResult<T> {
    data?: T;
    error?: unknown;
    isLoading: boolean;
    refetch(): Promise<unknown>;
  }
  export function useQuery<T>(options: {
    queryKey: readonly unknown[];
    queryFn: () => Promise<T>;
    refetchInterval?: number | false;
    enabled?: boolean;
  }): QueryResult<T>;

  export interface QueryClientLike {
    invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
    prefetchQuery<T>(options: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }): Promise<void>;
    getQueryData<T>(queryKey: readonly unknown[]): T | undefined;
  }
  export function useQueryClient(): QueryClientLike;
  export const queryClient: QueryClientLike;
}

declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: {
        allowpopups?: boolean | string;
        className?: string;
        partition?: string;
        ref?: unknown;
        src?: string;
        title?: string;
      };
    }
  }
}
