#include <stdio.h>
#include "../inc/util.h"

static int g_counter = 0;

static void bump(void)
{
    g_counter++;
}

int main(void)
{
    vec2_t v = { 1, 2 };
    bump();
    int r = util_scale(&v, UTIL_VERSION);
    printf("%d %d\n", r, g_counter);
    return util_add(r, g_counter);
}
