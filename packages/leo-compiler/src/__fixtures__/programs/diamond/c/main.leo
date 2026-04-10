import d.aleo;

program c.aleo {
  @noupgrade
  constructor() {}

  fn via_c() -> u32 {
    return d.aleo::base();
  }
}
