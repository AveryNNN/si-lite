#ifndef UTIL_H
#define UTIL_H

#define UTIL_VERSION 3

typedef struct vec2 {
    int x;
    int y;
} vec2_t;

int util_add(int a, int b);
int util_scale(vec2_t *v, int k);

#endif
