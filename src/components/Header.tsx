"use client";

import { useState, useRef } from "react";
import { BookMarked, Plus, Search, X, Sun, Moon, Monitor, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/context/AppContext";
import { exportData, importData, writeStorageImmediate } from "@/lib/storage";
import { CardModal } from "./CardModal";

interface HeaderProps {
  onOpenReview: () => void;
}

export function Header({ onOpenReview }: HeaderProps) {
  const { data, dispatch, searchQuery } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function handleSearchToggle() {
    if (searchOpen) {
      dispatch({ type: "SET_SEARCH", query: "" });
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: "SET_SEARCH", query: e.target.value });
  }

  function setTheme(theme: "light" | "dark" | "system") {
    dispatch({ type: "SET_THEME", theme });
  }

  function handleExport() {
    exportData(data);
  }

  function handleImportClick() {
    setImportError(null);
    fileInputRef.current?.click();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importData(file);
      if (confirm("This will replace all your current data. Are you sure?")) {
        writeStorageImmediate(imported);
        window.location.reload();
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    }
    e.target.value = "";
  }

  const themeIcon = {
    light: <Sun className="h-4 w-4" />,
    dark: <Moon className="h-4 w-4" />,
    system: <Monitor className="h-4 w-4" />,
  }[data.settings.theme];

  return (
    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b border-border">
      <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
        {/* Logo */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <BookMarked className="h-5 w-5 text-primary shrink-0" aria-hidden />
          {!searchOpen && (
            <span className="font-semibold text-base tracking-tight">My Stash</span>
          )}
          {searchOpen && (
            <Input
              ref={searchRef}
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="Search cards…"
              className="h-8 text-sm"
              aria-label="Search cards"
              onKeyDown={(e) => e.key === "Escape" && handleSearchToggle()}
            />
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSearchToggle}
            aria-label={searchOpen ? "Close search" : "Open search"}
            className="h-8 w-8"
          >
            {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAddOpen(true)}
            aria-label="Add idea"
            className="h-8 w-8"
          >
            <Plus className="h-4 w-4" />
          </Button>

          {/* Theme toggle */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-sm font-medium transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Toggle theme"
            >
              {themeIcon}
            </DropdownMenuTrigger>
            {/* DropdownMenuLabel renders Menu.GroupLabel, which throws
                (Base UI error #31) unless it sits inside a group. */}
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Theme</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <Sun className="h-4 w-4 mr-2" /> Light
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <Moon className="h-4 w-4 mr-2" /> Dark
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor className="h-4 w-4 mr-2" /> System
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Data menu */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="hidden sm:inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium transition-all outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Review mode"
            >
              Review
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenReview}>
                ✨ Daily Review
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleExport}>
                <Download className="h-4 w-4 mr-2" /> Export data
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleImportClick}>
                <Upload className="h-4 w-4 mr-2" /> Import data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Mobile review button */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 sm:hidden"
            onClick={onOpenReview}
            aria-label="Daily review"
          >
            ✨
          </Button>
        </div>
      </div>

      {importError && (
        <div role="alert" className="bg-destructive/10 text-destructive text-xs px-4 py-2 text-center">
          {importError}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        aria-hidden
        onChange={handleImportFile}
      />

      {addOpen && (
        <CardModal
          mode="create"
          onClose={() => setAddOpen(false)}
        />
      )}
    </header>
  );
}
