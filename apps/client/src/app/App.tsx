import { useEffect, useState } from "react";
import { MessageCircleMore } from "lucide-react";
import type { Session } from "@messenger/contracts";
import { api } from "../shared/api";
import { Auth } from "../features/auth";
import { Messenger } from "../pages/messenger";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void api
      .session()
      .then((found) => {
        if (active) setSession(found);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  if (loading)
    return (
      <div className="loading-screen">
        <span className="brand-mark">
          <MessageCircleMore size={25} />
        </span>
        <span>Opening Folio…</span>
      </div>
    );
  if (!session) return <Auth onSession={setSession} />;
  return (
    <Messenger
      key={`${session.user.id}.${session.deviceId}`}
      session={session}
      onLogout={() => setSession(null)}
    />
  );
}
