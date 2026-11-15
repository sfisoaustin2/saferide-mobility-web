export const config = {
  // Protects admin HTML pages AND any admin backend API routes
  matcher: [
    '/admin',
    '/admin.html',
    '/src/admin.html',
    '/api/admin/:path*',
  ],
};

export default function middleware(request) {
  const basicAuth = request.headers.get('authorization');

  if (basicAuth && basicAuth.startsWith('Basic ')) {
    try {
      const authValue = basicAuth.split(' ')[1];
      const decoded = atob(authValue);
      
      // Split only on the first colon so passwords containing ':' still work
      const separatorIndex = decoded.indexOf(':');
      if (separatorIndex !== -1) {
        const user = decoded.slice(0, separatorIndex);
        const pwd = decoded.slice(separatorIndex + 1);

        const validUser = process.env.ADMIN_USER;
        const validPass = process.env.ADMIN_PASSWORD;

        if (validUser && validPass && user === validUser && pwd === validPass) {
          // Valid staff login: allow access and prevent search engines/browsers from caching sensitive data
          return new Response(null, {
            headers: {
              'x-middleware-next': '1',
              'X-Robots-Tag': 'noindex, nofollow',
              'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            },
          });
        }
      }
    } catch (e) {
      // Ignore malformed Base64 headers and fall through to 401 prompt
    }
  }

  // No valid credentials: trigger the browser's built-in login popup
  return new Response('Staff Access Only. Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="SafeRide Mobility Staff Portal"',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}s