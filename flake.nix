{
  description = "claude-auto-retry: auto-resume Claude Code sessions on subscription rate limits and API overload";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.callPackage ./nix/package.nix { };

        checks.default = pkgs.runCommand "claude-auto-retry-test"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          } ''
          cp -r ${./.} src
          chmod -R u+w src
          cd src
          node --test test/*.test.js
          touch $out
        '';
      }) // {
      overlays.default = final: prev: {
        claude-auto-retry = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default = ./nix/nixos-module.nix;
      homeManagerModules.default = ./nix/home-manager-module.nix;
    };
}
