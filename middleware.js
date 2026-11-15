export const config = {
  // This ensures the password prompt ONLY triggers on /admin or /admin.html
  matcher: ['/admin', '/admin.html', '/src/admin.html'],
};

export default function middleware(request) {
  const basicAuth = request.headers.get('authorization');

  if (basicAuth) {
    const authValue = basicAuth.split(' ')[1];
    // Decode the Base64 "username:password" sent by the browser
    const [user, pwd] = atob(authValue).split(':');

    // Compare against your Vercel Environment Variables
    const validUser = process.env.ADMIN_USER;
    const validPass = process.env.ADMIN_PASSWORD;

    if (user === validUser && pwd === validPass) {
      // Password matches: let the staff member view admin.html
      return;
    }
  }

  // No valid credentials: trigger the browser's built-in login popup
  return new Response('Staff Access Only. Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="SafeRide Mobility Staff Portal"',
    },
  });
}