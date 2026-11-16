import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  BarChart3,
  FileText,
  Inbox,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Search,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AgentsPausedBanner } from "./AgentsPausedBanner.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Button } from "./components/ui/button.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { DiskBanner } from "./DiskBanner.tsx";
import { EntityCrumbs } from "./EntityCrumbs.tsx";
import { EventsProvider } from "./EventsProvider.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { useChangeFlash } from "./hooks/use-change-flash.ts";
import { applyTheme, currentTheme, type Theme } from "./lib/theme.ts";
import { cn } from "./lib/utils.ts";
import { isTypingTarget, shortcutFromKey } from "./shortcuts.ts";
import { TokenExpiryBanner } from "./TokenExpiryBanner.tsx";
import { useWorkbench } from "./Workbench.tsx";
import { waitingCount } from "./waiting.ts";

const nav = [
  { to: "/", label: "工作台", icon: LayoutDashboard, exact: true },
  { to: "/specs", label: "需求", icon: FileText, exact: false },
  { to: "/waiting", label: "待处理", icon: Inbox, exact: false, badge: true },
  { to: "/metrics", label: "度量", icon: BarChart3, exact: false },
] as const;

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(currentTheme()), []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
    >
      {theme === "dark" ? (
        <Sun className="size-4 shrink-0" />
      ) : (
        <Moon className="size-4 shrink-0" />
      )}
      {!collapsed && <span>{theme === "dark" ? "亮色模式" : "暗色模式"}</span>}
    </button>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  waiting,
}: {
  collapsed: boolean;
  onToggle: () => void;
  waiting: number;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const countIncreased = useChangeFlash(waiting, true);
  return (
    <aside
      className={cn(
        "afk-sidebar sticky top-0 flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-150",
        collapsed ? "w-[56px]" : "w-[224px]",
      )}
    >
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4">
        <img src="/icon.png" alt="" className="size-8 shrink-0 rounded-sm" />
        {!collapsed && (
          <span className="min-w-0">
            <strong className="block truncate text-[15px] leading-tight tracking-[0.08em]">
              AFK
            </strong>
            <span className="block text-[10px] tracking-[0.16em] text-muted-foreground">
              CONTROL TOWER
            </span>
          </span>
        )}
      </div>
      <nav className="flex-1 space-y-1 p-3" aria-label="主导航">
        {nav.map((item) => {
          const active = item.exact
            ? path === item.to
            : path === item.to || path.startsWith(`${item.to}/`);
          const Icon = item.icon;
          const countLabel = waiting > 0 ? `待处理 (${waiting})` : item.label;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              aria-label={"badge" in item ? countLabel : item.label}
              className={cn(
                "relative flex h-10 items-center gap-3 rounded-md px-2.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active &&
                  "afk-nav-active bg-sidebar-accent font-semibold text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && (
                <span className="flex-1 truncate">{item.label}</span>
              )}
              {"badge" in item && waiting > 0 ? (
                <span
                  role="status"
                  aria-label={`${waiting} 项待处理`}
                  className={cn(
                    "grid h-4 min-w-4 place-items-center rounded-full bg-state-blocked px-1 font-mono text-[10px] font-semibold text-background tabular",
                    countIncreased && "afk-count-bounce",
                    collapsed && "absolute -top-0.5 right-0.5",
                  )}
                >
                  {waiting}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-0.5 border-t border-sidebar-border p-2">
        <ThemeToggle collapsed={collapsed} />
        <button
          type="button"
          onClick={onToggle}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <PanelLeft className="size-4 shrink-0" />
          {!collapsed && <span>收起</span>}
        </button>
      </div>
    </aside>
  );
}

function Topbar({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="afk-topbar sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/90 px-6 backdrop-blur lg:px-10">
      <EntityCrumbs />
      <span className="ml-auto hidden text-xs tracking-wide text-muted-foreground lg:block">
        让实现阶段无人值守
      </span>
      <Button
        type="button"
        variant="ghost"
        aria-label="搜索需求与票"
        onClick={onSearch}
        className="afk-search flex h-8 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-[12px] text-muted-foreground hover:border-border-strong lg:ml-3"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">搜索需求、票、运行…</span>
        <kbd className="rounded-sm border bg-background px-1 font-mono text-[10px]">
          ⌘K
        </kbd>
      </Button>
    </header>
  );
}

export function Layout() {
  return (
    <EventsProvider>
      <Chrome />
    </EventsProvider>
  );
}

function Chrome() {
  const board = useWorkbench();
  const navigate = useNavigate();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const waiting = board.data ? waitingCount(board.data.waiting) : 0;

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const href = anchor.getAttribute("href");
      if (
        !href ||
        href.startsWith("http") ||
        href.startsWith("mailto:") ||
        href.startsWith("#")
      )
        return;
      event.preventDefault();
      router.history.push(href);
      const id = href.split("#")[1];
      if (id) {
        queueMicrotask(() =>
          document
            .getElementById(id)
            ?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
        );
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [router]);

  useEffect(() => {
    let pendingGo = false;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const next = shortcutFromKey(event, pendingGo);
      pendingGo = next.pendingGo;
      if (!next.shortcut) return;
      event.preventDefault();
      if (next.shortcut.type === "go") void navigate({ to: next.shortcut.to });
      if (next.shortcut.type === "search") setSearchOpen(true);
      if (next.shortcut.type === "help") setHelpOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    const update = () => {
      const base = document.title.replace(/^\(\d+\)\s*/, "");
      const next = waiting > 0 ? `(${waiting}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    update();
    const title = document.querySelector("title");
    const observer = new MutationObserver(update);
    if (title)
      observer.observe(title, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    return () => observer.disconnect();
  }, [waiting]);

  return (
    <TooltipProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          waiting={waiting}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onSearch={() => setSearchOpen(true)} />
          <TokenExpiryBanner />
          <AgentsPausedBanner />
          <DiskBanner />
          <main className="flex-1">
            <Outlet />
          </main>
        </div>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
