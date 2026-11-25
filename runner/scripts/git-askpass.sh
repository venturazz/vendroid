#!/bin/sh
# GIT_ASKPASS helper: hands the token from the environment to git (never on a command line).
case "$1" in
  Username*) echo "${VENDROID_GIT_USER:-x-access-token}" ;;
  *) echo "${VENDROID_GIT_TOKEN:-}" ;;
esac
