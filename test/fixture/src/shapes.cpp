class Shape {
public:
    virtual double area() const = 0;
};

class Circle : public Shape {
public:
    double area() const override { return 3.14159 * r * r; }
    double r = 1.0;
};

class Square : public Shape {
public:
    double area() const override { return side * side; }
    double side = 2.0;
};
