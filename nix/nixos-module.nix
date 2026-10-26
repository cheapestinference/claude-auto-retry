{ config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-auto-retry;
  common = import ./common.nix { inherit lib pkgs config; };
in
{
  options.programs.claude-auto-retry = common.options;

  config = lib.mkIf cfg.enable {
    # tmux is a hard runtime dependency (not just a suggestion): the wrapper only
    # works inside tmux, and reconcile/monitor both spawn the `tmux` binary directly.
    environment.systemPackages = [ cfg.package pkgs.tmux ];

    programs.bash.interactiveShellInit = lib.mkIf cfg.shellIntegration.bash (common.wrapperScript cfg);
    programs.zsh.interactiveShellInit = lib.mkIf cfg.shellIntegration.zsh (common.wrapperScript cfg);

    # No per-user system.activationScripts equivalent to home-manager's
    # home.activation exists at the NixOS system level (it would need to
    # enumerate logged-in users' $HOME and drop privileges for each), so
    # install-hook is re-applied here instead, on the timer that already
    # runs regardless. It's cheap (a single Node subprocess and a few-line JSON
    # rewrite) and self-heals within one interval of any upgrade instead of
    # waiting for the user's next login.
    systemd.user.services.claude-auto-retry-reconcile = lib.mkIf cfg.reconcileTimer.enable {
      description = "claude-auto-retry: re-arm monitors for all live claude tmux panes";
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "oneshot";
        # reconcile spawns detached monitor processes and exits; the default
        # KillMode=control-group would kill them along with it.
        KillMode = "process";
        ExecStart = "${cfg.package}/bin/claude-auto-retry reconcile";
      } // lib.optionalAttrs cfg.installHook {
        ExecStartPre = "-${cfg.package}/bin/claude-auto-retry install-hook";
      };
    };

    systemd.user.timers.claude-auto-retry-reconcile = lib.mkIf cfg.reconcileTimer.enable {
      description = "Periodically reconcile claude-auto-retry monitors (self-healing coverage)";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnStartupSec = cfg.reconcileTimer.startupDelay;
        OnUnitActiveSec = cfg.reconcileTimer.interval;
      };
    };
  };
}
