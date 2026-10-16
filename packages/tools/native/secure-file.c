#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

/* Keep every operation relative to opened directories. A pathname checked by
 * JavaScript must never be resolved again by a later file-system operation. */
#if defined(__APPLE__) || defined(__linux__)

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/random.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define PATH_LIMIT 32768U
#define MAX_FILE_BYTES (16U * 1024U * 1024U)
#define INPUT_TIMEOUT_MS 30000

static volatile sig_atomic_t interrupted = 0;

struct update {
  int parent_fd;
  int lock_fd;
  int temporary_fd;
  char *basename;
  char *lock_name;
  char temporary_name[64];
  struct stat lock_stat;
  struct stat temporary_stat;
  bool lock_owned;
  bool temporary_owned;
};

static void on_signal(int signal_number) {
  (void)signal_number;
  interrupted = 1;
}

static bool same_inode(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

/* Record created names even when cancellation arrives between open and fstat,
 * so cancellation can still identify and remove its own artifacts. */
static int stat_created(int fd, struct stat *info) {
  int result;
  do {
    result = fstat(fd, info);
  } while (result < 0 && errno == EINTR);
  return result;
}

static bool same_version(const struct stat *left, const struct stat *right) {
#if defined(__APPLE__)
  const struct timespec left_mtime = left->st_mtimespec;
  const struct timespec right_mtime = right->st_mtimespec;
  const struct timespec left_ctime = left->st_ctimespec;
  const struct timespec right_ctime = right->st_ctimespec;
#else
  const struct timespec left_mtime = left->st_mtim;
  const struct timespec right_mtime = right->st_mtim;
  const struct timespec left_ctime = left->st_ctim;
  const struct timespec right_ctime = right->st_ctim;
#endif
  return same_inode(left, right) && left->st_size == right->st_size &&
         left_mtime.tv_sec == right_mtime.tv_sec &&
         left_mtime.tv_nsec == right_mtime.tv_nsec &&
         left_ctime.tv_sec == right_ctime.tv_sec &&
         left_ctime.tv_nsec == right_ctime.tv_nsec;
}

/* Do not remove a lock or temporary name another process has replaced. */
static void unlink_owned(int parent_fd, const char *name,
                         const struct stat *owned) {
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      same_inode(&current, owned)) {
    (void)unlinkat(parent_fd, name, 0);
  }
}

static void cleanup(struct update *update) {
  if (update->parent_fd >= 0) {
    if (update->temporary_owned) {
      unlink_owned(update->parent_fd, update->temporary_name,
                   &update->temporary_stat);
    }
    if (update->lock_owned) {
      unlink_owned(update->parent_fd, update->lock_name, &update->lock_stat);
    }
  }
  if (update->temporary_fd >= 0) (void)close(update->temporary_fd);
  if (update->lock_fd >= 0) (void)close(update->lock_fd);
  if (update->parent_fd >= 0) (void)close(update->parent_fd);
  free(update->basename);
  free(update->lock_name);
}

static int64_t milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int wait_ready(int fd, short events, int64_t deadline) {
  for (;;) {
    if (interrupted) {
      errno = EINTR;
      return -1;
    }
    const int64_t now = milliseconds();
    if (now < 0) return -1;
    const int64_t remaining = deadline - now;
    if (remaining <= 0) {
      errno = ETIMEDOUT;
      return -1;
    }
    struct pollfd ready = {.fd = fd, .events = events, .revents = 0};
    const int result = poll(&ready, 1, (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) {
      if (result == 0) errno = ETIMEDOUT;
      return -1;
    }
    if ((ready.revents & (events | POLLHUP)) != 0) return 0;
    errno = EIO;
    return -1;
  }
}

static int write_all(int fd, const void *data, size_t length) {
  const unsigned char *bytes = data;
  while (length > 0) {
    if (interrupted) {
      errno = EINTR;
      return -1;
    }
    const size_t chunk = length > (size_t)SSIZE_MAX ? (size_t)SSIZE_MAX : length;
    const ssize_t written = write(fd, bytes, chunk);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) {
      if (written == 0) errno = EIO;
      return -1;
    }
    bytes += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

/* stdout is nonblocking, so an abandoned IPC peer cannot retain a file lock. */
static int send_bytes(const void *data, size_t length) {
  const unsigned char *bytes = data;
  const int64_t now = milliseconds();
  if (now < 0) return -1;
  const int64_t deadline = now + INPUT_TIMEOUT_MS;
  while (length > 0) {
    if (wait_ready(STDOUT_FILENO, POLLOUT, deadline) != 0) return -1;
    const size_t chunk = length > (size_t)SSIZE_MAX ? (size_t)SSIZE_MAX : length;
    const ssize_t written = write(STDOUT_FILENO, bytes, chunk);
    if (written < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (written <= 0) {
      if (written == 0) errno = EIO;
      return -1;
    }
    bytes += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int send_text(const char *text) {
  return send_bytes(text, strlen(text));
}

/* Messages are fixed literals; only the numeric errno is interpolated. */
static int fail(struct update *update, const char *message, int error_number) {
  char frame[256];
  cleanup(update);
  const int length = error_number == 0
                         ? snprintf(frame, sizeof(frame), "{\"error\":\"%s\"}\n",
                                    message)
                         : snprintf(frame, sizeof(frame),
                                    "{\"error\":\"%s\",\"errno\":%d}\n", message,
                                    error_number);
  if (length > 0 && (size_t)length < sizeof(frame)) {
    /* A signal still gets cleanup, even if it prevents a final error frame. */
    (void)send_bytes(frame, (size_t)length);
  }
  return 1;
}

static bool parse_size(const char *input, size_t *result) {
  if (*input == '\0') return false;
  size_t value = 0;
  for (const unsigned char *cursor = (const unsigned char *)input;
       *cursor != '\0'; cursor++) {
    if (*cursor < '0' || *cursor > '9') return false;
    const size_t digit = (size_t)(*cursor - '0');
    if (value > (SIZE_MAX - 1 - digit) / 10) return false;
    value = value * 10 + digit;
  }
  *result = value;
  return true;
}

static int open_parent(struct update *update, const char *path,
                       bool create_directories) {
  const size_t length = strnlen(path, PATH_LIMIT + 1);
  if (length < 2 || length > PATH_LIMIT || path[0] != '/' ||
      path[length - 1] == '/') {
    errno = EINVAL;
    return -1;
  }
  char *copy = strdup(path + 1);
  if (copy == NULL) return -1;
  /* Validate before creating anything, including the last component. */
  for (char *cursor = copy; *cursor != '\0';) {
    char *slash = strchr(cursor, '/');
    const size_t component_length = slash == NULL ? strlen(cursor)
                                                  : (size_t)(slash - cursor);
    if (component_length == 0 ||
        (component_length == 1 && cursor[0] == '.') ||
        (component_length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      free(copy);
      errno = EINVAL;
      return -1;
    }
    cursor += component_length;
    if (*cursor == '/') cursor++;
  }
  int parent_fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) {
    free(copy);
    return -1;
  }
  char *component = copy;
  for (;;) {
    if (interrupted) {
      (void)close(parent_fd);
      free(copy);
      errno = EINTR;
      return -1;
    }
    char *slash = strchr(component, '/');
    if (slash == NULL) break;
    *slash = '\0';
    int next_fd = openat(parent_fd, component,
                         O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next_fd < 0 && errno == ENOENT && create_directories) {
      if (mkdirat(parent_fd, component, 0777) != 0 && errno != EEXIST) {
        const int saved_errno = errno;
        (void)close(parent_fd);
        free(copy);
        errno = saved_errno;
        return -1;
      }
      next_fd = openat(parent_fd, component,
                       O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next_fd < 0) {
      const int saved_errno = errno;
      (void)close(parent_fd);
      free(copy);
      errno = saved_errno;
      return -1;
    }
    (void)close(parent_fd);
    parent_fd = next_fd;
    component = slash + 1;
  }
  update->basename = strdup(component);
  free(copy);
  if (update->basename == NULL) {
    (void)close(parent_fd);
    return -1;
  }
  update->parent_fd = parent_fd;
  return 0;
}

static int acquire_lock(struct update *update) {
  static const char suffix[] = ".hikaro-lock";
  const size_t length = strlen(update->basename);
  update->lock_name = malloc(length + sizeof(suffix));
  if (update->lock_name == NULL) return -1;
  memcpy(update->lock_name, update->basename, length);
  memcpy(update->lock_name + length, suffix, sizeof(suffix));
  update->lock_fd = openat(update->parent_fd, update->lock_name,
                            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                            0600);
  if (update->lock_fd < 0) return -1;
  if (stat_created(update->lock_fd, &update->lock_stat) != 0) return -1;
  update->lock_owned = true;
  char pid[32];
  const int length_pid = snprintf(pid, sizeof(pid), "%jd", (intmax_t)getpid());
  if (length_pid <= 0 || (size_t)length_pid >= sizeof(pid)) {
    errno = EOVERFLOW;
    return -1;
  }
  return write_all(update->lock_fd, pid, (size_t)length_pid);
}

static int read_current(struct update *update, size_t max_bytes, bool *exists,
                        struct stat *version, unsigned char **content,
                        size_t *length) {
  const int fd = openat(update->parent_fd, update->basename,
                        O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) {
      *exists = false;
      *length = 0;
      *content = NULL;
      return 0;
    }
    return -1;
  }
  int result = -1;
  unsigned char *buffer = NULL;
  if (fstat(fd, version) != 0) goto done;
  if (!S_ISREG(version->st_mode)) {
    errno = EINVAL;
    goto done;
  }
  if (version->st_size < 0 || (uintmax_t)version->st_size > max_bytes) {
    errno = EFBIG;
    goto done;
  }
  const size_t size = (size_t)version->st_size;
  buffer = malloc(size == 0 ? 1 : size);
  if (buffer == NULL) goto done;
  size_t received = 0;
  while (received < size) {
    if (interrupted) {
      errno = EINTR;
      goto done;
    }
    const size_t remainder = size - received;
    const size_t chunk = remainder > (size_t)SSIZE_MAX ? (size_t)SSIZE_MAX : remainder;
    const ssize_t count = read(fd, buffer + received, chunk);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      if (count == 0) errno = ESTALE;
      goto done;
    }
    received += (size_t)count;
  }
  unsigned char extra;
  ssize_t extra_count;
  do {
    extra_count = read(fd, &extra, 1);
  } while (extra_count < 0 && errno == EINTR && !interrupted);
  if (extra_count != 0) {
    if (extra_count > 0) errno = ESTALE;
    goto done;
  }
  struct stat after;
  if (fstat(fd, &after) != 0) goto done;
  if (!same_version(version, &after)) {
    errno = ESTALE;
    goto done;
  }
  *exists = true;
  *length = size;
  *content = buffer;
  buffer = NULL;
  result = 0;
done: {
    const int saved_errno = errno;
    free(buffer);
    (void)close(fd);
    errno = saved_errno;
    return result;
  }
}

static int receive_header(char *header, size_t capacity, int64_t deadline) {
  size_t length = 0;
  for (;;) {
    if (wait_ready(STDIN_FILENO, POLLIN, deadline) != 0) return -1;
    unsigned char byte;
    const ssize_t received = read(STDIN_FILENO, &byte, 1);
    if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (received <= 0) {
      if (received == 0) errno = EPIPE;
      return -1;
    }
    if (byte == '\n') {
      header[length] = '\0';
      return 0;
    }
    if (byte == '\0' || length + 1 >= capacity) {
      errno = EINVAL;
      return -1;
    }
    header[length++] = (char)byte;
  }
}

static int create_temporary(struct update *update) {
  for (int attempt = 0; attempt < 16; attempt++) {
    unsigned char random[16];
    if (getentropy(random, sizeof(random)) != 0) return -1;
    static const char hexadecimal[] = "0123456789abcdef";
    memcpy(update->temporary_name, ".hikaro-", 8);
    for (size_t index = 0; index < sizeof(random); index++) {
      update->temporary_name[8 + index * 2] = hexadecimal[random[index] >> 4];
      update->temporary_name[9 + index * 2] = hexadecimal[random[index] & 15];
    }
    memcpy(update->temporary_name + 40, ".tmp", 5);
    update->temporary_fd =
        openat(update->parent_fd, update->temporary_name,
               O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (update->temporary_fd < 0) {
      if (errno == EEXIST) continue;
      return -1;
    }
    if (stat_created(update->temporary_fd, &update->temporary_stat) != 0) return -1;
    update->temporary_owned = true;
    return 0;
  }
  errno = EEXIST;
  return -1;
}

static int receive_content(struct update *update, size_t length,
                           int64_t deadline) {
  unsigned char buffer[65536];
  while (length > 0) {
    if (wait_ready(STDIN_FILENO, POLLIN, deadline) != 0) return -1;
    const size_t chunk = length > sizeof(buffer) ? sizeof(buffer) : length;
    const ssize_t received = read(STDIN_FILENO, buffer, chunk);
    if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (received <= 0) {
      if (received == 0) errno = EPIPE;
      return -1;
    }
    if (write_all(update->temporary_fd, buffer, (size_t)received) != 0) return -1;
    length -= (size_t)received;
  }
  return 0;
}

int main(int argc, char **argv) {
  struct update update = {.parent_fd = -1, .lock_fd = -1, .temporary_fd = -1};
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = on_signal;
  if (sigemptyset(&action.sa_mask) != 0 ||
      sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0) {
    return fail(&update, "Cannot install cancellation handlers", errno);
  }
  action.sa_handler = SIG_IGN;
  if (sigaction(SIGPIPE, &action, NULL) != 0) {
    return fail(&update, "Cannot configure IPC", errno);
  }
  const int stdout_flags = fcntl(STDOUT_FILENO, F_GETFL);
  if (stdout_flags < 0 ||
      fcntl(STDOUT_FILENO, F_SETFL, stdout_flags | O_NONBLOCK) != 0) {
    return fail(&update, "Cannot configure IPC", errno);
  }
  size_t max_bytes;
  if (argc != 4 ||
      (strcmp(argv[1], "read") != 0 && strcmp(argv[1], "update") != 0) ||
      !parse_size(argv[3], &max_bytes) || max_bytes > MAX_FILE_BYTES) {
    return fail(&update, "Invalid helper arguments", 0);
  }
  const bool writing = strcmp(argv[1], "update") == 0;
  if (open_parent(&update, argv[2], writing) != 0) {
    return fail(&update, "Cannot securely open parent directory", errno);
  }
  if (writing && acquire_lock(&update) != 0) {
    return fail(&update, "File update locked or lock could not be created", errno);
  }
  struct stat version;
  bool exists;
  unsigned char *content;
  size_t length;
  if (read_current(&update, max_bytes, &exists, &version, &content, &length) != 0) {
    return fail(&update, "Cannot securely read a stable regular file", errno);
  }
  if (!writing && !exists) {
    return fail(&update, "File does not exist", ENOENT);
  }
  char header[128];
  const int header_length = snprintf(header, sizeof(header),
                                     "{\"exists\":%s,\"length\":%zu}\n",
                                     exists ? "true" : "false", length);
  const int sent = send_bytes(header, (size_t)header_length);
  const int sent_content = sent == 0 ? send_bytes(content, length) : -1;
  free(content);
  if (sent != 0 || sent_content != 0) return fail(&update, "IPC output closed", errno);
  if (!writing) {
    cleanup(&update);
    return 0;
  }
  int64_t now = milliseconds();
  if (now < 0 || receive_header(header, sizeof(header), now + INPUT_TIMEOUT_MS) != 0) {
    return fail(&update, "Update preparation interrupted or timed out", errno);
  }
  size_t new_length;
  if (strncmp(header, "PREPARE ", 8) != 0 ||
      !parse_size(header + 8, &new_length) || new_length > max_bytes) {
    return fail(&update, "Invalid update preparation or update aborted", 0);
  }
  if (create_temporary(&update) != 0) {
    return fail(&update, "Cannot create private temporary file", errno);
  }
  if (receive_content(&update, new_length, now + INPUT_TIMEOUT_MS) != 0) {
    return fail(&update, "Update content interrupted or timed out", errno);
  }
  const mode_t mask = umask(0);
  (void)umask(mask);
  const mode_t mode = exists ? version.st_mode & 0777 : (mode_t)(0666 & ~mask);
  if (fchmod(update.temporary_fd, mode) != 0 || fsync(update.temporary_fd) != 0 ||
      fstat(update.temporary_fd, &update.temporary_stat) != 0) {
    return fail(&update, "Cannot prepare temporary file", errno);
  }
  if (send_text("{\"prepared\":true}\n") != 0) {
    return fail(&update, "IPC output closed", errno);
  }
  now = milliseconds();
  if (now < 0 || receive_header(header, sizeof(header), now + INPUT_TIMEOUT_MS) != 0) {
    return fail(&update, "Update commit interrupted or timed out", errno);
  }
  if (strcmp(header, "COMMIT") != 0 || interrupted) {
    return fail(&update, "Update aborted", 0);
  }
  struct stat current;
  const int status = fstatat(update.parent_fd, update.basename, &current,
                             AT_SYMLINK_NOFOLLOW);
  if ((exists && (status != 0 || !S_ISREG(current.st_mode) ||
                  !same_version(&version, &current))) ||
      (!exists && (status == 0 || errno != ENOENT))) {
    return fail(&update, "File changed during editing. Read it before retrying.", 0);
  }
  struct stat temporary_current;
  if (fstatat(update.parent_fd, update.temporary_name, &temporary_current,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_version(&update.temporary_stat, &temporary_current)) {
    return fail(&update, "Temporary file changed during editing", 0);
  }
  if (interrupted) return fail(&update, "Update interrupted", 0);
  if (exists) {
    if (renameat(update.parent_fd, update.temporary_name, update.parent_fd,
                  update.basename) != 0) {
      return fail(&update, "Cannot commit file update", errno);
    }
    update.temporary_owned = false;
  } else if (linkat(update.parent_fd, update.temporary_name, update.parent_fd,
                     update.basename, 0) != 0) {
    return fail(&update, "Cannot commit new file without overwriting", errno);
  }
  cleanup(&update);
  return send_text("{\"committed\":true}\n") == 0 ? 0 : 1;
}

#else

#include <stdio.h>
int main(void) {
  (void)fputs("{\"error\":\"Secure file operations require macOS or Linux\"}\n", stdout);
  return 1;
}

#endif
