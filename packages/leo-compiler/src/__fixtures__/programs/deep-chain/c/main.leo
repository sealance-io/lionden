import d.aleo;

program c.aleo {
  @noupgrade
  constructor() {}

  fn step_c() -> u32 {
    return d.aleo::base();
  }
}
