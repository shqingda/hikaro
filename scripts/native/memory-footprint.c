#include <libproc.h>
#include <sys/resource.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end;
  errno = 0;
  long pid = strtol(argv[1], &end, 10);
  if (errno || *end || pid <= 0 || pid > INT_MAX) return 2;
  struct rusage_info_v4 info = {0};
  if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&info)) {
    perror("proc_pid_rusage");
    return 1;
  }
  printf("%llu\n", (unsigned long long)info.ri_phys_footprint);
  return 0;
}
