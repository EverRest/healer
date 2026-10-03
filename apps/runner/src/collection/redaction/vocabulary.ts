/**
 * The template vocabulary of redaction ruleset v1 — the words a log *template* is built from, as
 * opposed to the values interpolated into it. `free_text_span` clears nothing outside this list
 * (R-07a): a customer's name, a tenant's company name or a free-text note is not in it, so it
 * cannot reach the control plane, and the set can be incomplete without being unsafe — an unlisted
 * word omits the excerpt, it never lets one through. Names that are also common words (mark, grant,
 * bill, rose, hunter) are deliberately absent.
 */
const WORDS = `
a an the of in on at to for from with without by and or nor not no is are was were be been being has have had
can cannot could would should must might shall did do does done if then else when while during after
before until since because than as but so this that these those it its into onto over under between within
failed fail failure failures error errors exception exceptions warning warn fatal info debug trace critical
timeout timeouts timed out expired expire expiry connection connections connect connected connecting disconnect
refused reset closed close closing aborted abort cancelled canceled unavailable available denied unauthorized
forbidden invalid missing unexpected unknown illegal bad malformed corrupt corrupted request requests response
responses status code codes http https server client service services database db query queries cache redis
queue job jobs worker workers handler controller repository manager provider factory validator parse parsing
parser read reading write writing property properties undefined null nan object objects array arrays string
strings number numbers boolean type types value values key keys id ids name names length size limit limits
exceeded exceeds exceed maximum minimum too large many long short memory heap space disk file files
directory path found find exist exists existing duplicate conflict constraint violation unique foreign
deadlock lock locked transaction rollback commit retry retries retrying attempt attempts user users account
accounts customer order orders payment payments charge session auth authentication authorization permission
permissions rate throttled upstream downstream gateway health check ready startup shutdown start stop stopped
started running process thread pool exhausted full empty buffer stream socket port host address dns resolve
lookup certificate tls ssl handshake protocol version mismatch unsupported supported implemented deprecated
config configuration environment variable flag feature enabled disabled setting settings schema migration
table column row rows index record entry event events message payload body header headers content format
encoding decode decoding encode serialize deserialize json xml yaml unable input output line position offset
expected got received sent send sending receive receiving set get put post delete patch update create created
add remove removed fetch load loading save saving call calling called method function class module import
export require required optional argument arguments parameter parameters param params map list item items
data internal external local remote public private default current previous next first last all any each
every some none one two three new old open opened opening reading read-only readonly writable executing
execute execution run task tasks step steps stage pipeline build deploy deployment release rollback rollout
unreachable reachable healthy unhealthy degraded slow latency duration elapsed second seconds ms millisecond
milliseconds minute minutes hour hours day days time times date timestamp clock expired valid validation
validate verify verification signature checksum hash digest token tokens bearer secret credential credentials
password refresh revoked scope scopes role roles tenant tenants project projects component components env
prod production staging development api v1 v2 v3 test tests testing
`;

export const TEMPLATE_VOCABULARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));

/** Upper-case tokens a log template legitimately contains. Other ALL-CAPS tokens (an acronym that
 *  is a customer's name) are free text; errno names are listed, not pattern-matched (`ERIC` is a name). */
export const UPPERCASE_ALLOWLIST: ReadonlySet<string> = new Set(
  `HTTP HTTPS JSON XML YAML SQL URL URI UUID TLS SSL DNS TCP UDP API GET POST PUT DELETE PATCH HEAD OPTIONS OK
   NULL NaN EOF TTL CPU OOM IO SIGTERM SIGKILL SIGINT 5XX 4XX
   ECONNREFUSED ECONNRESET ECONNABORTED ETIMEDOUT ENOTFOUND ENOENT EACCES EPERM EEXIST EADDRINUSE EPIPE
   EAI_AGAIN EMFILE ENOMEM ENOSPC EHOSTUNREACH ENETUNREACH EBUSY EISDIR ENOTDIR`.split(/\s+/),
);
