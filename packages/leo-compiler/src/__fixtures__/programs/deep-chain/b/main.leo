import c.aleo;

program b.aleo {
  @noupgrade
  constructor() {}

  fn step_b() -> u32 {
    return c.aleo::step_c();
  }
}
