import { generateToken, verifyToken } from './token.js';
import { ExpiredException, UnauthorizedException, BadRequestException, BasicAuthHeaders } from './errors'

/***
 * Security / Authentication Info
 * ===
 * 
 * Depending on your needs (public build / deployment, etc.) you might consider overriding the key / method
 * below with e.g. a worker secret / remote env / KV lookup ... but keep in mind this code is worker-only
 * (i.e. never exposed to the client) and the values can easily be rolled over ... As long as the codebase
 * is kept in a private repo (which you would want for the routes) it should be OK to be left as-is
 * 
 * 1. To change the key, edit value for VITE_AUTH_SECRET_KEY in ".env.local"
 * 2. To add a secure route, add a new folder to your routes folder and include an "auth.json" at the root:
 *    {
 *      "name": "An example user or organisation name", <== optional
 *      "passphrase": "let me in", <== required**
 *      "expires": "1 October 2022 00:00:0000 +10" <== optional: force access to the route to expire
 *    }
 * 
 * **/

// retrieve our secret key - if it hasn't been set an error will be thrown during build, see "vite.config.js"
const SECRET_KEY = import.meta.env.VITE_AUTH_SECRET_KEY;

// retrieve our auth routes
const ROUTE_AUTH = getRouteAuth();

// process authentication for each of the routes
function getRouteAuth() {
  const authRoutes = import.meta.glob('/routes/*/auth.json', { eager: true });
  const markdownRaw = import.meta.glob('/routes/**/*.md', { as: 'raw', eager: true });

  // create our auth dictionary
  const auth = new Map();

  // extract the routes dir from the glob import key (only works if there is an "auth.json" somewhere)
  const routesDir = Object.keys(authRoutes)[0]?.split('/').slice(0, -2).join('/');

  if (!routesDir) {
    console.error(`❌ [auth:route] no "auth.json" files exist in your routes\n- see /src/worker/auth/index.js`);
    return auth;
  }

  const availableRoutes = new Set(['public', 'shared']);
  for (const [path, routeAuth] of Object.entries(authRoutes)) {
    const route = path.split('/').at(-2)

    if (route === 'public' || route === 'shared') {
      console.error(`❌ [auth:route] "${routesDir}/${route}" includes an "auth.json" - you should remove this`);
      continue;
    }

    // add the route to the list of those with auth files
    availableRoutes.add(route);


    if (!routeAuth.passphrase) {
      console.error(`❌ [auth:route] "${path}" is missing a passphrase - ${route} is not accessible`);
      continue;
    }

    if (auth.has(routeAuth.passphrase)) {
      console.error(`❌ [auth:route] "${routesDir}/${route}" shares a passphrase with "${routesDir}/${auth.get(routeAuth.passphrase).route}" - ${route} is not accessible`);
      continue;
    }
    
    // convert expiry to a date object
    let expires = routeAuth.expires && new Date(routeAuth.expires);

    // set default expiry to a ~year in advance, warning if provided expiry is invalid
    if (isNaN(expires)) {
      // if expiry is a date object we know it has been set but is invalid
      if (expires) {
        console.error(`❌ [auth:route] "${path}" expiry date is invalid - it has been set to +1 year`);
      }
      // set expiry it to today + 364 days
      expires = new Date(new Date().setHours(24 * 364));
    }

    auth.set(routeAuth.passphrase, { ...routeAuth.default, expires, route });
  }

  const warned = new Set();
  for (const path in markdownRaw) {
    const route = path.slice(routesDir.length + 1).split('/')[0];
    if (route && !availableRoutes.has(route)) {
      availableRoutes.add(route);
      console.error(`❌ [auth:route] "${routesDir}/${route}" is missing an "auth.json" - ${route} is not accessible`);
    }
  }

  return auth;
}

const sanitiseUser = user =>
  user.replace(/[^a-z]/ig, '').slice(0, 20).toLowerCase();

async function cookieAuth(ref, request) {
  const cookies = request.headers.get('cookie');

  if (!cookies) {
    return;
  }

  for (const [, key, val] of cookies.matchAll(/([^= ]+)="?([^;"]+)/g)) {
    if (key === 'Authorization') {
      // set cookie data
      const data = {
        type: 'cookie',
        token: val,
      };

      // check for a user value in POST data
      const postUser = await postAuth(request, true);
      if (typeof postUser === 'string' || ref.user) {
        data.user = postUser || ref.user || 'anon';
      }

      return data;
    }
  }
}

async function postAuth(request, getUserForToken) {
  const contentType = request.headers.get('content-type');

  if (!contentType || !contentType.includes('form')) {
    return;
  }

  const formData = await request.clone().formData();
  const pass = formData.get('pass');
  let user = formData.get('user');

  if (getUserForToken) {
    return user && sanitiseUser(user);
  }

  if (!pass) {
    return;
  }

  const data = {
    type: 'post',
    pass: pass,
  };

  if (user) {
    data.user = sanitiseUser(user);
  }

  return data;
}

// modified from https://developers.cloudflare.com/workers/examples/basic-auth/
function headerAuth({ headers }) {
  const auth = headers.get('Authorization');

  // no auth header
  if (!auth) {
    return;
  }

  const [scheme, encoded] = auth.split(' ');
  const isBearer = scheme === 'Bearer';

  // The Authorization header must start with "Basic" or "Bearer"
  if (!encoded || (!isBearer && scheme !== 'Basic')) {
    return {
      error: BadRequestException('Malformed Authorization header'),
    };
  }

  // return the encoded token
  if (isBearer) {
    return {
      type: 'bearer',
      token: encoded,
    };
  }

  // Decodes the base64 value and performs unicode normalization.
  // @see https://datatracker.ietf.org/doc/html/rfc7613#section-3.3.2 (and #section-4.2.2)
  // @see https://dev.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String/normalize
  const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const decoded = new TextDecoder().decode(buffer).normalize();

  // The username & password are split by the first colon.
  //=> example: "username:password"
  const index = decoded.indexOf(':');

  // The user & password are split by the first colon and MUST NOT contain control characters.
  // @see https://tools.ietf.org/html/rfc5234#appendix-B.1 (=> "CTL = %x00-1F / %x7F")
  if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
    return {
      error: BadRequestException('Invalid credentials'),
    }
  }

  return {
    type: 'basic',
    pass: decoded.substring(index + 1),
    // for user we'll default to 'anon' where a name isn't supplied
    // saves roundtrips / user annoyance (in what is probably an API call)
    user: sanitiseUser(decoded.substring(0, index)) || 'anon',
  };
}

// verifies auth credentials against a route
export async function verifyAuthCredentials(auth, ref) {
  // lookup data associated with passphrase
  const data = ROUTE_AUTH.get(auth.pass);

  if (!data) {
    // passphrase not found
    auth.error = UnauthorizedException('Passphrase not found');

    if (ref.isApi && auth.type === 'basic') {
      auth.headers = BasicAuthHeaders;
    }

  } else if (ref.route && data.route !== ref.route) {
    // request route doesn't match passphrase route
    auth.error = UnauthorizedException('Invalid credentials');
  } else if (data.expires < Date.now()) {
    // route has expired
    auth.error = ExpiredException('Link has expired');
  } else {
    // generate a token from the passphrase data
    const { token, expires } = await generateToken(data.route, data.expires, SECRET_KEY);
    auth.verified = { expires };
    auth.token = token;
    auth.route = data.route;

    // specify a HttpOnly auth cookie containing our token
    auth.headers = {
      'Set-Cookie': `Authorization="${token}"; HttpOnly; Secure; Path=${ref.base}${data.route}; SameSite=Strict; Expires="${expires.toUTCString()}"`,
    }
  }
}

// verifies an auth token against a route
export async function verifyAuthToken(auth, ref) {
  try {
    auth.verified = await verifyToken(auth.token, ref.route, SECRET_KEY);
    auth.route = ref.route;
  } catch (e) {
    auth.error = UnauthorizedException(e.message);
  }
}

// retrieve auth credentials / token from the current request
export async function getAuth(request, ref) {
  getRouteAuth();
  // retrieve / parse credentials
  return await postAuth(request) || await cookieAuth(ref, request) || headerAuth(request) ||
  // default to authentication instructions
  {
    error: UnauthorizedException(
      `To access the API, generate a token via Basic Authentication or POST, where user={your first name} and pass={the shared passphrase} e.g > curl -u [firstname]:[passphrase] [api-url]; curl -X POST -d 'user=[firstname]&pass=[passphrase]' [api-url]`,
    ),
    headers: {
      ...(ref.isApi && BasicAuthHeaders),
    },
  };
}
