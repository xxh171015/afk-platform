import { Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBlocked } from "./BlockedQueue.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Button } from "./components/ui/button.tsx";
import { Separator } from "./components/ui/separator.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { EventsProvider } from "./EventsProvider.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { isTypingTarget, shortcutFromKey } from "./shortcuts.ts";
import { waitingCount } from "./waiting.ts";

// Chrome of the control tower: 工作台 / 需求 / 待处理, ⌘K search, g-h/g-b/g-s and ?.
// Pages still render ordinary <a href> so isolated tests need no router; clicks are pushed into history.

export function Layout() {
  return (
    <EventsProvider>
      <Chrome />
    </EventsProvider>
  );
}

function Chrome() {
  const queue = useBlocked();
  const navigate = useNavigate();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const waiting = queue.data ? waitingCount(queue.data) : 0;

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

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-6xl px-6 py-4 pb-12">
        <header className="mb-4 flex flex-wrap items-center gap-4">
          <Link
            to="/"
            className="text-lg font-semibold text-foreground no-underline"
          >
            AFK
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link to="/" activeProps={{ className: "font-semibold" }}>
              工作台
            </Link>
            <Link to="/specs" activeProps={{ className: "font-semibold" }}>
              需求
            </Link>
            <Link to="/waiting" activeProps={{ className: "font-semibold" }}>
              {waiting > 0 ? `待处理 (${waiting})` : "待处理"}
            </Link>
          </nav>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            aria-label="搜索需求与票"
            onClick={() => setSearchOpen(true)}
          >
            搜索
            <kbd className="text-muted-foreground">⌘K</kbd>
          </Button>
        </header>
        <Separator className="mb-4" />
        <Outlet />
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      </div>
    </TooltipProvider>
  );
}
