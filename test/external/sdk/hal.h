#ifndef HAL_H
#define HAL_H
typedef struct { int pin; int mode; } hal_gpio_t;
int hal_gpio_write(hal_gpio_t *g, int v);
#endif
