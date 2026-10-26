"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, Play, Trash2, RefreshCw } from "lucide-react";
import { useAppStore } from "@/lib/store";

interface Torrent {
  id: string;
  filename: string;
  progress: number;
  status: string;
  added: string;
}

export default function DebridPage() {
  // The token stays on the server; the page only needs to know one is configured.
  const token = useAppStore((s) => Boolean(s.settings.realDebridConfigured));
  const [magnet, setMagnet] = useState("");
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [user, setUser] = useState<{ username: string; premium: number } | null>(null);

  const fetchTorrents = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/debrid?action=torrents");
      if (res.ok) {
        const data = await res.json();
        setTorrents(data.torrents ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [token]);

  const checkUser = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/debrid");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      }
    } catch {
      setUser(null);
    }
  }, [token]);

  useEffect(() => {
    checkUser();
    fetchTorrents();
    const interval = setInterval(fetchTorrents, 10000);
    return () => clearInterval(interval);
  }, [checkUser, fetchTorrents]);

  const addMagnet = async () => {
    if (!magnet.trim() || !token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/debrid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addMagnet", magnet: magnet.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add magnet");
      setMagnet("");
      await fetchTorrents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const deleteTorrent = async (id: string) => {
    if (!token) return;
    await fetch(`/api/debrid?id=${id}`, { method: "DELETE" });
    fetchTorrents();
  };

  if (!token) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
        <h1 className="mb-4 text-2xl font-semibold">Real-Debrid</h1>
        <p className="mb-6 max-w-md text-netflix-light-gray">
          Add your Real-Debrid API token in Settings to stream cached torrents instantly.
        </p>
        <Link href="/settings" className="rounded bg-netflix-red px-6 py-2 font-semibold hover:bg-netflix-red-hover">
          Configure Real-Debrid
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-8 md:px-12 lg:px-16">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold md:text-3xl">Real-Debrid</h1>
          {user && (
            <p className="mt-1 text-sm text-netflix-light-gray">
              {user.username} · {user.premium ? "Premium" : "Free"}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={fetchTorrents}
          className="flex items-center gap-2 text-sm text-netflix-light-gray hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="mb-8 max-w-2xl">
        <label className="mb-2 block text-sm text-netflix-light-gray">Add magnet link</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={magnet}
            onChange={(e) => setMagnet(e.target.value)}
            placeholder="magnet:?xt=urn:btih:..."
            className="flex-1 rounded bg-[#333] px-4 py-3 text-white placeholder:text-netflix-gray focus:outline-none focus:ring-2 focus:ring-white/30"
          />
          <button
            type="button"
            onClick={addMagnet}
            disabled={loading}
            className="flex items-center gap-2 rounded bg-netflix-red px-4 py-3 font-semibold hover:bg-netflix-red-hover disabled:opacity-50"
          >
            <Plus className="h-5 w-5" />
            Add
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>

      <div className="space-y-3">
        {torrents.length === 0 && (
          <p className="text-netflix-light-gray">No torrents yet. Paste a magnet link above.</p>
        )}
        {torrents.map((torrent) => (
          <div
            key={torrent.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded bg-netflix-dark p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{torrent.filename || "Processing..."}</p>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1.5 flex-1 max-w-xs rounded bg-white/20">
                  <div
                    className="h-full rounded bg-netflix-red transition-all"
                    style={{ width: `${torrent.progress}%` }}
                  />
                </div>
                <span className="text-xs text-netflix-light-gray">
                  {torrent.progress}% · {torrent.status}
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              {torrent.progress >= 100 && (
                <Link
                  href={`/watch/debrid-${torrent.id}`}
                  className="flex items-center gap-1 rounded bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/80"
                >
                  <Play className="h-4 w-4 fill-current" />
                  Play
                </Link>
              )}
              <button
                type="button"
                onClick={() => deleteTorrent(torrent.id)}
                className="rounded border border-white/30 p-2 hover:bg-white/10"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
