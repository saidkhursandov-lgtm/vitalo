import { NextResponse, type NextRequest } from 'next/server';
import { legacyRedirect } from '@/lib/paths';

/** Old Mini App addresses on vitalo.uz -> the matching site page (release 6.6). */
export function middleware(req: NextRequest) {
  const to = legacyRedirect(req.nextUrl.pathname, req.nextUrl.searchParams);
  if (!to) return NextResponse.next();
  // Behind nginx the site itself is plain http on 127.0.0.1: build the address from what the visitor typed
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  return NextResponse.redirect(new URL(to, `${proto}://${host}`), 308);
}

export const config = {
  matcher: ['/orders/:path*', '/support/:path*', '/bonus', '/favorites', '/notifications', '/profile/:path*', '/campaign/:path*', '/catalog/products'],
};
