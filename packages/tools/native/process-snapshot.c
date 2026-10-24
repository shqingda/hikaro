#define _DARWIN_C_SOURCE 1

#include <stdio.h>

#if defined(__APPLE__)
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

#define MAX_NODES 256
#define MAX_DEPTH 16
#define MAX_ISSUES (MAX_NODES * 2 + 2)

struct identity {
  pid_t pid;
  uint64_t seconds;
  uint64_t microseconds;
};

struct node {
  struct proc_bsdinfo info;
  unsigned depth;
  bool present;
};

struct issue {
  pid_t pid;
  const char *kind;
};

static struct node nodes[MAX_NODES];
static struct issue issues[MAX_ISSUES];
static pid_t visited[MAX_NODES], missing[MAX_NODES], mismatched[MAX_NODES];
static size_t node_count, issue_count, visited_count, missing_count;
static size_t mismatched_count;
static bool incomplete;

static void add_issue(pid_t pid, const char *kind) {
  incomplete = true;
  for (size_t i = 0; i < issue_count; i++)
    if (issues[i].pid == pid && strcmp(issues[i].kind, kind) == 0) return;
  if (issue_count < MAX_ISSUES)
    issues[issue_count++] = (struct issue){pid, kind};
}

static void add_pid(pid_t *values, size_t *count, pid_t pid) {
  for (size_t i = 0; i < *count; i++)
    if (values[i] == pid) return;
  if (*count < MAX_NODES) values[(*count)++] = pid;
}

static bool was_visited(pid_t pid) {
  for (size_t i = 0; i < visited_count; i++)
    if (visited[i] == pid) return true;
  return false;
}

static bool number(const char **cursor, uint64_t maximum, uint64_t *value) {
  const char *text = *cursor;
  if (*text < '0' || *text > '9') return false;
  uint64_t result = 0;
  do {
    unsigned digit = (unsigned)(*text - '0');
    if (result > (maximum - digit) / 10) return false;
    result = result * 10 + digit;
    text++;
  } while (*text >= '0' && *text <= '9');
  *cursor = text;
  *value = result;
  return true;
}

static bool parse(const char *text, struct identity *identity) {
  uint64_t pid;
  if (!number(&text, INT_MAX, &pid) || pid <= 1 || *text++ != ':' ||
      !number(&text, UINT64_MAX, &identity->seconds) || *text++ != ':' ||
      !number(&text, 999999, &identity->microseconds) || *text != '\0' ||
      (identity->seconds == 0 && identity->microseconds != 0))
    return false;
  identity->pid = (pid_t)pid;
  return true;
}

static struct identity identity_of(const struct proc_bsdinfo *info) {
  return (struct identity){(pid_t)info->pbi_pid, info->pbi_start_tvsec,
                          info->pbi_start_tvusec};
}

static bool matches(const struct proc_bsdinfo *info,
                    const struct identity *identity) {
  return info->pbi_pid == (uint32_t)identity->pid &&
         info->pbi_start_tvsec == identity->seconds &&
         info->pbi_start_tvusec == identity->microseconds;
}

static bool inspect(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size == (int)sizeof(*info) && info->pbi_pid == (uint32_t)pid)
    return true;
  if (size == 0 && (errno == ESRCH || errno == ENOENT))
    add_pid(missing, &missing_count, pid);
  else
    add_issue(pid, errno == EPERM || errno == EACCES ? "permission"
                                                    : "unavailable");
  return false;
}

static bool recheck(struct node *node) {
  struct identity identity = identity_of(&node->info);
  struct proc_bsdinfo current;
  if (!inspect(identity.pid, &current)) {
    node->present = false;
    add_issue(identity.pid, "identity_changed");
    return false;
  }
  if (!matches(&current, &identity)) {
    node->present = false;
    add_pid(mismatched, &mismatched_count, identity.pid);
    add_issue(identity.pid, "identity_changed");
    return false;
  }
  node->info = current;
  return true;
}

static void descendants(struct node *parent) {
  if (!recheck(parent)) return;
  pid_t pid = (pid_t)parent->info.pbi_pid;
  // A spare slot makes a full result explicitly incomplete, without an
  // unbounded allocation or an all-process query.
  pid_t children[MAX_NODES + 1];
  errno = 0;
  int count = proc_listchildpids(pid, children, sizeof(children));
  if (count < 0 || (count == 0 && errno != 0)) {
    add_issue(pid, errno == EPERM || errno == EACCES ? "permission"
                                                   : "unavailable");
    return;
  }
  if (count >= MAX_NODES + 1) {
    add_issue(pid, "node_limit");
    count = MAX_NODES + 1;
  }
  if (parent->depth >= MAX_DEPTH && count > 0) {
    add_issue(pid, "depth_limit");
    return;
  }
  struct proc_bsdinfo candidates[MAX_NODES];
  size_t candidate_count = 0;
  for (int i = 0; i < count; i++) {
    pid_t child = children[i];
    if (child <= 1 || was_visited(child)) continue;
    if (visited_count == MAX_NODES) {
      add_issue(pid, "node_limit");
      break;
    }
    visited[visited_count++] = child;
    struct proc_bsdinfo info;
    if (!inspect(child, &info)) continue;
    if (info.pbi_ppid != (uint32_t)pid) {
      add_issue(child, "identity_changed");
      continue;
    }
    candidates[candidate_count++] = info;
  }
  // Parent identity must bracket all child observations: a recycled parent
  // PID must never grant access to an unrelated descendant tree.
  if (!recheck(parent)) return;
  for (size_t i = 0; i < candidate_count; i++)
    nodes[node_count++] =
        (struct node){candidates[i], parent->depth + 1, true};
}

static void print_ids(const pid_t *values, size_t count) {
  putchar('[');
  for (size_t i = 0; i < count; i++)
    printf("%s%d", i ? "," : "", values[i]);
  putchar(']');
}

int main(int argc, char **argv) {
  struct identity inputs[MAX_NODES];
  if (argc < 2 || argc > MAX_NODES + 1) {
    fputs("Expected 1 to 256 pid:startSec:startUsec arguments\n", stderr);
    return 2;
  }
  for (int i = 1; i < argc; i++) {
    if (!parse(argv[i], &inputs[i - 1]) || was_visited(inputs[i - 1].pid)) {
      fputs("Invalid or duplicate process identity\n", stderr);
      return 2;
    }
    visited[visited_count++] = inputs[i - 1].pid;
  }
  pid_t caller = getppid();
  for (int i = 0; i < argc - 1; i++) {
    struct proc_bsdinfo info;
    const struct identity *identity = &inputs[i];
    if (!inspect(identity->pid, &info)) continue;
    if (identity->seconds == 0) {
      if (info.pbi_ppid != (uint32_t)caller) {
        add_issue(identity->pid, "permission");
        continue;
      }
    } else if (!matches(&info, identity)) {
      add_pid(mismatched, &mismatched_count, identity->pid);
      continue;
    }
    nodes[node_count++] = (struct node){info, 0, true};
  }
  for (size_t i = 0; i < node_count; i++) descendants(&nodes[i]);
  printf("{\"supported\":true,\"incomplete\":%s,\"processes\":[",
         incomplete ? "true" : "false");
  bool separator = false;
  for (size_t i = 0; i < node_count; i++) {
    const struct proc_bsdinfo *info = &nodes[i].info;
    if (!nodes[i].present) continue;
    printf("%s{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,"
           "\"startSec\":\"%" PRIu64 "\",\"startUsec\":\"%" PRIu64
           "\",\"status\":%u}",
           separator ? "," : "", info->pbi_pid, info->pbi_ppid,
           info->pbi_pgid, info->pbi_start_tvsec, info->pbi_start_tvusec,
           info->pbi_status);
    separator = true;
  }
  printf("],\"missing\":");
  print_ids(missing, missing_count);
  printf(",\"mismatched\":");
  print_ids(mismatched, mismatched_count);
  printf(",\"issues\":[");
  for (size_t i = 0; i < issue_count; i++)
    printf("%s{\"pid\":%d,\"kind\":\"%s\"}", i ? "," : "",
           issues[i].pid, issues[i].kind);
  puts("]}");
  return 0;
}
#else
int main(void) {
  puts("{\"supported\":false,\"incomplete\":true,\"processes\":[],"
       "\"missing\":[],\"mismatched\":[],"
       "\"issues\":[{\"pid\":0,\"kind\":\"unsupported\"}]}");
  return 0;
}
#endif
