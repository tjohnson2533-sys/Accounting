import { createClient } from "@supabase/supabase-js";

// Client-side reads only, under the anon key. RLS restricts every row to the user's
// entities. Mutations go through the Node service (see api.ts), never the service-role
// key — which must never reach the browser.
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);
