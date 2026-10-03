import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// `/api/webhooks` is authenticated by provider signature, not by a session —
// Meta's POSTs carry no cookies and must never be redirected to /login.
// `/api/cron` authenticates itself with CRON_SECRET.
const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth", "/api/webhooks", "/api/cron", "/api/health"];

// Match a whole path segment: `/auth` must not also make `/authors` public.
function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Refreshes the Supabase auth session on every request and redirects
 * unauthenticated users away from protected pages. This is the outermost
 * layer of authorization (route access); org/role authorization happens
 * deeper in the service layer and in RLS.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return supabaseResponse;
}
