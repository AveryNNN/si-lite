#include "../inc/util.h"

struct other { int x; int g_counter; };

/* Same names as main.c, different things: a parameter, a local and a struct member. */
int shadow_me(int g_counter)
{
    struct other o = { 1, 2 };
    int x = g_counter + o.x + o.g_counter;
    return x;
}
