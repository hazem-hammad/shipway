<?php
/**
 * Installed by setup/install.sh at /opt/shipway-db-signon/signon.php and served as
 * https://ship.<base-domain>/db/signon.php — edits here are overwritten on the next install.
 *
 * The dashboard's "Manage" button on a MySQL database points here with that database's id. This
 * script turns the id into a phpMyAdmin session already connected as that database's own user, so
 * the link lands on the database's table list with no login form in between.
 *
 * How it authorises: nothing here decides who may see what. nginx has already run its
 * `auth_request` against the Shipway session before this script is reached (see
 * setup/templates/nginx-dashboard.conf), and the credentials themselves are fetched by replaying
 * the caller's OWN session cookie against Shipway's API on localhost. So a request can only ever
 * obtain credentials the same session could have read from the dashboard's "Reveal password"
 * button, which is the point: this adds no new way in, it only saves the copy-and-paste.
 *
 * The handover to phpMyAdmin is its stock `signon` auth type: credentials go into a PHP session
 * under a name phpMyAdmin is configured to look for ($cfg['Servers'][1]['SignonSession']), and it
 * reads them out on the next request. See libraries/classes/Plugins/Auth/AuthenticationSignon.php.
 */

declare(strict_types=1);

/** Where Shipway's API listens — the same 127.0.0.1:8090 the dashboard vhost proxies to. */
const SHIPWAY_API = 'http://127.0.0.1:8090';
/** Must match $cfg['Servers'][$i]['SignonSession'] in /opt/phpmyadmin/config.inc.php. */
const SIGNON_SESSION = 'ShipwaySignon';
/** Must match $cfg['Servers'][$i]['SignonCookieParams'], or phpMyAdmin reopens a different session. */
const SIGNON_COOKIE_PARAMS = [
    'lifetime' => 0,
    'path' => '/db/',
    'domain' => '',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
];
/** The `$i` of the signon server entry in config.inc.php. */
const SIGNON_SERVER_INDEX = 1;

/** Renders a short error page (no Shipway styling to keep in sync) and stops. */
function fail(string $message): never
{
    http_response_code(502);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Database console</title>';
    echo '<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}</style>';
    echo '</head><body><h1>Could not open the console</h1><p>';
    echo htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo '</p><p><a href="/databases">Back to Databases</a></p></body></html>';
    exit;
}

/* $_GET rather than filter_input(INPUT_GET): identical validation, and it can also be exercised
   from the command line, where INPUT_GET reads the (empty) real request instead of what a test set. */
$id = filter_var($_GET['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if ($id === false) {
    fail('That link is missing the database it should open.');
}

/* Replay the caller's own cookies against the API: their Shipway session is the authorisation. */
$cookie = $_SERVER['HTTP_COOKIE'] ?? '';
$curl = curl_init(SHIPWAY_API . '/api/databases/' . $id . '/credentials');
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['Cookie: ' . $cookie, 'Accept: application/json'],
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 10,
]);
$body = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$curlError = curl_error($curl);
curl_close($curl);

if ($body === false) {
    fail('Shipway did not answer: ' . $curlError);
}
if ($status === 401 || $status === 403) {
    /* The session expired between nginx's check and this request. Send them back to sign in. */
    header('Location: /databases');
    exit;
}
if ($status !== 200) {
    fail('Shipway could not read that database\'s credentials (HTTP ' . $status . ').');
}

$creds = json_decode((string) $body, true);
if (!is_array($creds) || !isset($creds['name'], $creds['username'], $creds['password'], $creds['host'], $creds['port'], $creds['engine'])) {
    fail('Shipway returned credentials this script did not understand.');
}

if ($creds['engine'] !== 'mysql') {
    /* Postgres has its own console, which takes no credentials from a URL. */
    header('Location: /db/pgadmin/');
    exit;
}

/*
 * Hand off to phpMyAdmin. `session_write_close()` before the redirect matters: phpMyAdmin opens
 * this same session by id on the very next request, and an unwritten session would still be locked.
 */
ini_set('session.use_cookies', 'true');
ini_set('session.use_strict_mode', 'true');
session_set_cookie_params(SIGNON_COOKIE_PARAMS);
session_name(SIGNON_SESSION);
session_start();
session_regenerate_id(true);

$_SESSION['PMA_single_signon_user'] = (string) $creds['username'];
$_SESSION['PMA_single_signon_password'] = (string) $creds['password'];
$_SESSION['PMA_single_signon_host'] = (string) $creds['host'];
$_SESSION['PMA_single_signon_port'] = (string) $creds['port'];
/* phpMyAdmin signs its own URLs with this; a fresh one per handover keeps sessions independent. */
$_SESSION['PMA_single_signon_HMAC_secret'] = bin2hex(random_bytes(16));
unset($_SESSION['PMA_single_signon_error_message']);
session_write_close();

$target = '/db/phpmyadmin/index.php?server=' . SIGNON_SERVER_INDEX
    . '&route=' . rawurlencode('/database/structure')
    . '&db=' . rawurlencode((string) $creds['name']);
header('Location: ' . $target);
