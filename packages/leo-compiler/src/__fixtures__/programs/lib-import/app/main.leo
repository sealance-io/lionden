import math.aleo;

program app.aleo {
  @noupgrade
  constructor() {}

  fn compute(a: u32, b: u32) -> u32 {
    return math.aleo::add(a, b);
  }
}
