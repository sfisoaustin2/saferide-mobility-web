export const config = {
  matcher: ['/admin', '/admin.html', '/src/admin.html'],
};

export default function middleware(request) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASSWORD;

  // Fail closed if Vercel environment variables are not configured
  if (!expectedUser || !expectedPass) {
    return new Response('Admin credentials not configured on server.', {
      status: 500,
    });
  }

  const authHeader = request.headers.get('authorization');

  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.slice(6).trim();
      const decoded = atob(base64Credentials);
      const separatorIndex = decoded.indexOf(':');

      if (separatorIndex !== -1) {
        const user = decoded.slice(0, separatorIndex);
        const pass = decoded.slice(separatorIndex + 1);

        if (user === expectedUser && pass === expectedPass) {
          // Valid credentials: allow request to proceed to admin.html
          return;
        }
      }
    } catch {
      // Ignore malformed Base64 headers and fall through to 401 prompt
    }
  }

  // Trigger browser's built-in Basic Auth login prompt
  return new Response('Staff Access Only. Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="SafeRide Mobility Control Room"',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}