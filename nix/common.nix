{ lib, pkgs, config }:
{
  options = {
    enable = lib.mkEnableOption "claude-auto-retry (auto-resume Claude Code on subscription rate limits and API overload)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage <claude-auto-retry>/nix/package.nix { }";
      description = "The claude-auto-retry package to use.";
    };

    shellIntegration = {
      bash = lib.mkOption {
        type = lib.types.bool;
        default = config.programs.bash.enable;
        description = "Wrap the `claude` command for interactive bash shells.";
      };
      zsh = lib.mkOption {
        type = lib.types.bool;
        default = config.programs.zsh.enable;
        description = "Wrap the `claude` command for interactive zsh shells.";
      };
    };

    installHook = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Install the `StopFailure` hook into Claude Code's settings for
        event-driven overload detection (no terminal scraping). The hook
        command embeds this package's store path, so it is re-applied on
        every reconcile run to stay in sync across upgrades. `install-hook`
        is idempotent, matching its previous entry by a fixed marker rather
        than the old path.
      '';
    };

    reconcileTimer = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Run `claude-auto-retry reconcile` on a timer (systemd --user on
          Linux, a launchd agent on Darwin), so a monitor that dies (or a
          `claude` started outside the wrapper) gets covered within one
          interval instead of staying unmonitored forever.
        '';
      };
      startupDelay = lib.mkOption {
        type = lib.types.str;
        default = "2min";
        description = "How long after the user session starts before the first reconcile run (lets tmux settle). Linux only; the launchd agent always runs at load.";
      };
      interval = lib.mkOption {
        type = lib.types.str;
        default = "5min";
        description = "How often to re-run reconcile after the first run.";
      };
    };
  };

  # The wrapper's own template already branches on $ZSH_VERSION at runtime, so
  # the same substituted script is sourced by both bash and zsh (see src/wrapper.sh).
  wrapperScript = cfg: builtins.replaceStrings
    [ "__LAUNCHER_PATH__" ]
    [ cfg.package.launcherPath ]
    (builtins.readFile cfg.package.wrapperTemplatePath);
}
