/**
 * Environment boundary shared by the Pi MCP bridge and every executor child.
 *
 * This is defense in depth for credentials carried in environment variables;
 * it is not an OS sandbox and cannot hide secrets stored in files or argv.
 */
export function isSensitiveEnvironmentName(name: string): boolean {
  return (
    /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|BEARER|COOKIE|PAT|JWT|DATABASE_URL|DB_URL|CONNECTION_STRING)(?:_|$)/i.test(name)
    || /^(?:PGPASSWORD|PGPASSFILE|MYSQL_PWD|REDISCLI_AUTH|KUBECONFIG)$/i.test(name)
    || /^(?:(?:HTTP|HTTPS|ALL)_PROXY|NPM_CONFIG_(?:PROXY|HTTPS_PROXY))$/i.test(name)
  );
}

const UNSAFE_CHILD_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  "CDPATH",
  "INPUTRC",
  "BASH_XTRACEFD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONWARNINGS",
  "PYTHONBREAKPOINT",
  "PYTHONINSPECT",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "PERL5DB",
  "ERL_AFLAGS",
  "ERL_FLAGS",
  "ELIXIR_ERL_OPTIONS",
  "ERL_LIBS",
  "GOFLAGS",
  "CGO_CFLAGS",
  "CGO_LDFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "RUSTFLAGS",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "R_PROFILE",
  "R_PROFILE_USER",
  "R_HOME",
  "DOTNET_STARTUP_HOOKS",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_SHARED_STORE",
  "DOTNET_ROOT",
  "DOTNET_ROOT(X86)",
  "DOTNET_HOST_PATH",
  "CORECLR_PROFILER",
  "CORECLR_PROFILER_PATH",
  "CORECLR_PROFILER_PATH_32",
  "CORECLR_PROFILER_PATH_64",
  "CORECLR_PROFILER_PATH_ARM32",
  "CORECLR_PROFILER_PATH_ARM64",
  "CORECLR_ENABLE_PROFILING",
  "DOTNET_PROFILER_PATH",
  "DOTNET_PROFILER_PATH_32",
  "DOTNET_PROFILER_PATH_64",
  "DOTNET_PROFILER_PATH_ARM32",
  "DOTNET_PROFILER_PATH_ARM64",
  "DOTNET_DIAGNOSTICPORTS",
  "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "CC",
  "CXX",
  "AR",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

export function isUnsafeChildEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    isSensitiveEnvironmentName(name)
    || UNSAFE_CHILD_ENVIRONMENT_NAMES.has(upper)
    || upper.startsWith("BASH_FUNC_")
    || upper.startsWith("COMPLUS_")
  );
}

export function safeChildProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isUnsafeChildEnvironmentName(entry[0]),
    ),
  );
}
