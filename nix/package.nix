{ lib, stdenv, nodejs, makeWrapper, tmux, procps }:

stdenv.mkDerivation (finalAttrs: {
  pname = "claude-auto-retry";
  version = (lib.importJSON ../package.json).version;

  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter = name: type:
      let base = baseNameOf name; in
      !(type == "directory" && (base == "test" || base == "node_modules" || base == "nix"));
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  dontConfigure = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/claude-auto-retry
    cp -r bin src systemd launchd LICENSE README.md CHANGELOG.md package.json $out/lib/claude-auto-retry/
    chmod +x $out/lib/claude-auto-retry/bin/cli.js $out/lib/claude-auto-retry/bin/tmux-status.sh

    mkdir -p $out/bin
    # tmux isn't an npm dependency (this tool spawns the `tmux` binary directly via
    # child_process), so without a hard PATH dependency here the CLI silently no-ops
    # ("needs a running tmux server") on any system that hasn't separately installed
    # it. --prefix guarantees it's found regardless of the caller's own PATH.
    #
    # procps is here for the same reason: reconcile.js and tmux.js shell out to
    # `ps` for pane liveness, process start time and the full process table. A
    # systemd --user unit only gets NixOS's default unit PATH (coreutils,
    # findutils, gnugrep, gnused, systemd), which has no `ps`, so the reconcile
    # timer failed with "reconcile failed: spawn ps ENOENT" on every interval
    # until this was added. Darwin ships ps in the base system and has no procps.
    makeWrapper ${nodejs}/bin/node $out/bin/claude-auto-retry \
      --add-flags "$out/lib/claude-auto-retry/bin/cli.js" \
      --prefix PATH : ${lib.makeBinPath ([ tmux ] ++ lib.optionals stdenv.hostPlatform.isLinux [ procps ])}
    ln -s $out/lib/claude-auto-retry/bin/tmux-status.sh $out/bin/claude-auto-retry-tmux-status

    runHook postInstall
  '';

  passthru = {
    # Consumed by the NixOS/home-manager modules to build the shell wrapper
    # and locate the launcher without re-deriving the store layout above.
    launcherPath = "${finalAttrs.finalPackage}/lib/claude-auto-retry/src/launcher.js";
    wrapperTemplatePath = "${finalAttrs.finalPackage}/lib/claude-auto-retry/src/wrapper.sh";
  };

  meta = {
    description = "Automatically retry Claude Code sessions on subscription rate limits and sustained API overload";
    homepage = "https://github.com/cheapestinference/claude-auto-retry";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
    mainProgram = "claude-auto-retry";
  };
})
