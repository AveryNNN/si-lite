#include "../inc/util.h"

/* Adds two numbers. */
int util_add(int a, int b)
{
    return a + b;
}

int util_scale(vec2_t *v, int k)
{
    v->x = util_add(v->x, v->x * (k - 1));
    v->y = util_add(v->y, v->y * (k - 1));
    return v->x + v->y;
}
