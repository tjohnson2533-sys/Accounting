import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabase";

export interface Entity {
  id: string;
  name: string;
}

interface EntityState {
  entities: Entity[];
  activeId: string | null;
  setActiveId: (id: string) => void;
  userId: string | null;
  loading: boolean;
}

const Ctx = createContext<EntityState | null>(null);

export function EntityProvider({ children }: { children: ReactNode }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      setUserId(auth.user?.id ?? null);
      // RLS returns only the entities this user is a member of.
      const { data } = await supabase.from("entities").select("id, name").order("name");
      const list = (data ?? []) as Entity[];
      setEntities(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
      setLoading(false);
    })();
  }, []);

  return (
    <Ctx.Provider value={{ entities, activeId, setActiveId, userId, loading }}>{children}</Ctx.Provider>
  );
}

export function useEntity(): EntityState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEntity must be used within EntityProvider");
  return v;
}
